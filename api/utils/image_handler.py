import os
import uuid
from fastapi import HTTPException, UploadFile
import paramiko

HOST = "103.191.241.38"
PORT = 22
USERNAME = "nsghbdco"
PASSWORD = "Mho.2V0eKC]91b"  # or use key authentication

# -------------------- ROUTES --------------------

def upload_to_hosting(file: UploadFile):
    ext = os.path.splitext(file.filename)[1]
    filename = f"{uuid.uuid4().hex}{ext}"
    remote_path = f"/home/nsghbdco/public_html/img/team/{filename}"
    try:
        transport = paramiko.Transport((HOST, PORT))
        transport.connect(username=USERNAME, password=PASSWORD)
        
        sftp = paramiko.SFTPClient.from_transport(transport)

        with file.file as f:
            sftp.putfo(f, remote_path)  # Upload the file-like object

        sftp.close()
        transport.close()
        
        return f"https://www.nsghbd.com/img/team/{filename}"
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="Authentication failed")
    except paramiko.SSHException as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
def delete_from_hosting(file_url: str):
    
    filename = file_url.split("/")[-1]
    remote_path = f"/home/nsghbdco/public_html/img/team/{filename}"
    try:
        transport = paramiko.Transport((HOST, PORT))
        transport.connect(username=USERNAME, password=PASSWORD)
        sftp = paramiko.SFTPClient.from_transport(transport)

        # Delete the file
        sftp.remove(remote_path)

        sftp.close()
        transport.close()
    except FileNotFoundError:
        # File already missing, ignore
        pass
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="Authentication failed")
    except paramiko.SSHException as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
