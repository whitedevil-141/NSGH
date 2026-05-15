"""Compare SQLAlchemy models (Base.metadata) against the live database schema.

This is a read-only report. It will list missing tables, missing columns,
extra columns, and column-nullability/type differences where detectable.

Designed to be safe to run on startup and to give a concise output for
an operator to manually fix misconfigurations.
"""
from typing import List, Tuple

from sqlalchemy import Integer, String, Text, inspect, text
from sqlalchemy.sql.type_api import TypeEngine


def _simplify_type(t: TypeEngine) -> str:
    try:
        return t.__class__.__name__.lower()
    except Exception:
        return str(t)


def _model_col_to_sql(col, dialect_name: str) -> str:
    """Generate a simple SQL fragment for a model column type.

    Best-effort: String -> VARCHAR(length) or VARCHAR(255),
    Text -> TEXT, Integer -> INT.
    """
    coltype = col.type
    if isinstance(coltype, String):
        length = getattr(coltype, "length", None) or 255
        sql_type = f"VARCHAR({length})"
    elif isinstance(coltype, Text):
        sql_type = "TEXT"
    elif isinstance(coltype, Integer):
        sql_type = "INT"
    else:
        sql_type = getattr(coltype, "__class__", type(coltype)).__name__.upper()

    null_sql = "NULL" if col.nullable else "NOT NULL"
    return f"{sql_type} {null_sql}"


def check_schema(engine, base, apply: bool = False) -> List[Tuple]:
    """Check DB schema against models. If apply=True, attempt safe ALTERs:
    - ADD missing columns
    - Adjust nullability to match model (make NULL or DROP NOT NULL)

    Returns a report list.
    """
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    model_tables = {t.name: t for t in base.metadata.sorted_tables}

    report: List[Tuple] = []
    fixes: List[Tuple] = []

    dialect = engine.dialect.name

    for table_name, table in model_tables.items():
        if table_name not in existing_tables:
            report.append(("missing_table", table_name, None))
            continue

        existing_cols = {c["name"]: c for c in inspector.get_columns(table_name)}
        model_cols = {c.name: c for c in table.columns}

        for col_name, col in model_cols.items():
            if col_name not in existing_cols:
                report.append(("missing_column", table_name, col_name))
                col_sql = _model_col_to_sql(col, dialect)
                fixes.append(("add_column", table_name, col_name, col_sql))
                continue

            existing = existing_cols[col_name]
            model_nullable = col.nullable
            existing_nullable = existing.get("nullable", True)
            if model_nullable != existing_nullable:
                report.append(("nullable_mismatch", table_name, col_name, model_nullable, existing_nullable))
                fixes.append(("nullable", table_name, col_name, model_nullable))

            model_type = _simplify_type(col.type)
            existing_type_obj = existing.get("type")
            existing_type = (existing_type_obj and _simplify_type(existing_type_obj)) or str(existing_type_obj)

            equivalents = False
            if model_type in ("string", "varchar") and "varchar" in str(existing_type).lower():
                equivalents = True
            if model_type in ("text",) and "text" in str(existing_type).lower():
                equivalents = True
            if model_type in ("integer",) and ("int" in str(existing_type).lower() or "integer" in str(existing_type).lower()):
                equivalents = True

            if not equivalents:
                report.append(("type_mismatch", table_name, col_name, model_type, existing_type))

        for col_name in existing_cols.keys():
            if col_name not in model_cols:
                report.append(("extra_column", table_name, col_name))

    for table_name in existing_tables:
        if table_name not in model_tables:
            report.append(("extra_table", table_name, None))

    if not report:
        print("✓ DB schema matches models (no issues detected)")
        return report

    print("⚠️  DB schema issues detected:")
    for item in report:
        kind = item[0]
        if kind == "missing_table":
            print(f"  - Missing table: {item[1]}")
        elif kind == "extra_table":
            print(f"  - Extra table in DB: {item[1]}")
        elif kind == "missing_column":
            print(f"  - Missing column `{item[2]}` in table `{item[1]}`")
        elif kind == "extra_column":
            print(f"  - Extra column `{item[2]}` in table `{item[1]}` (exists in DB but not in models)")
        elif kind == "nullable_mismatch":
            _, tbl, col, model_n, exist_n = item
            print(f"  - Nullability mismatch for `{col}` in `{tbl}`: model nullable={model_n} vs db nullable={exist_n}")
        elif kind == "type_mismatch":
            _, tbl, col, mtype, etype = item
            print(f"  - Type mismatch for `{col}` in `{tbl}`: model={mtype} vs db={etype}")
        else:
            print(f"  - {item}")

    if not fixes:
        print("\nNo automatic fixes proposed.")
        return report

    print("\nProposed automatic fixes (safe subset):")
    for f in fixes:
        if f[0] == "add_column":
            print(f"  - ADD COLUMN `{f[2]}` on `{f[1]}` => {f[3]}")
        elif f[0] == "nullable":
            print(f"  - Set nullability for `{f[2]}` on `{f[1]}` => nullable={f[3]}")

    if not apply:
        print("\nRun with apply=True to execute the safe fixes.")
        return report

    with engine.begin() as conn:
        for f in fixes:
            try:
                if f[0] == "add_column":
                    table_name = f[1]
                    col_name = f[2]
                    col_sql = f[3]
                    stmt = f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_sql}"
                    print(f"Applying: {stmt}")
                    conn.execute(text(stmt))
                elif f[0] == "nullable":
                    table_name = f[1]
                    col_name = f[2]
                    make_nullable = f[3]
                    if dialect == "mysql":
                        colinfo = {c["name"]: c for c in inspect(conn).get_columns(table_name)}.get(col_name)
                        if not colinfo:
                            print(f"Could not find column info for {col_name} in {table_name}")
                            continue
                        existing_type = str(colinfo.get("type"))
                        if make_nullable:
                            stmt = f"ALTER TABLE {table_name} MODIFY COLUMN {col_name} {existing_type} NULL"
                        else:
                            stmt = f"ALTER TABLE {table_name} MODIFY COLUMN {col_name} {existing_type} NOT NULL"
                        print(f"Applying: {stmt}")
                        conn.execute(text(stmt))
                    elif dialect in ("postgresql", "postgres"):
                        if make_nullable:
                            stmt = f"ALTER TABLE {table_name} ALTER COLUMN {col_name} DROP NOT NULL"
                        else:
                            stmt = f"ALTER TABLE {table_name} ALTER COLUMN {col_name} SET NOT NULL"
                        print(f"Applying: {stmt}")
                        conn.execute(text(stmt))
                    else:
                        print(f"Skipping nullability change for unsupported dialect: {dialect}")
            except Exception as e:
                print(f"Error applying fix {f}: {e}")

    print("\n✓ Applied automatic safe fixes (see logs above).")
    return report
