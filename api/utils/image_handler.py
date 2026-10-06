import os
import uuid
from contextlib import contextmanager
from fastapi import HTTPException, UploadFile
import paramiko

from api.utils.config import get_env, get_int_env


HOST = get_env("SFTP_HOST")
PORT = get_int_env("SFTP_PORT", 22)
USERNAME = get_env("SFTP_USERNAME")
PASSWORD = get_env("SFTP_PASSWORD")

@contextmanager
def hosting_connection():
    transport = None
    sftp = None
    try:
        transport = paramiko.Transport((HOST, PORT))
        transport.connect(username=USERNAME, password=PASSWORD)
        sftp = paramiko.SFTPClient.from_transport(transport)
        yield sftp
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=502, detail="Image hosting authentication failed. Check the server SFTP credentials.")
    except (paramiko.SSHException, OSError):
        raise HTTPException(status_code=502, detail="Image hosting is unavailable. Please try again later.")
    finally:
        if sftp is not None:
            sftp.close()
        if transport is not None:
            transport.close()

def upload_to_hosting(file: UploadFile):
    ext = os.path.splitext(file.filename)[1]
    filename = f"{uuid.uuid4().hex}{ext}"
    remote_path = f"/home/nsghbdco/public_html/img/team/{filename}"
    with hosting_connection() as sftp:
        with file.file as f:
            sftp.putfo(f, remote_path)  # Upload the file-like object
    return f"https://www.nsghbd.com/img/team/{filename}"
    
def delete_from_hosting(file_url: str):
    
    filename = file_url.split("/")[-1]
    remote_path = f"/home/nsghbdco/public_html/img/team/{filename}"
    with hosting_connection() as sftp:
        try:
            sftp.remove(remote_path)
        except FileNotFoundError:
            # File already missing, ignore.
            pass
