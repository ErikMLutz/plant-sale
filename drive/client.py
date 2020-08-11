import os
import pickle

from googleapiclient.discovery import build
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request

from settings import GOOGLE_API_SCOPES

# If modifying these scopes, delete the file token.pickle.
SCOPES = GOOGLE_API_SCOPES


class DriveClient:
    def __init__(self):
        creds = None
        # The file token.pickle stores the user's access and refresh tokens, and is
        # created automatically when the authorization flow completes for the first
        # time.
        if os.path.exists('token.pickle'):
            with open('token.pickle', 'rb') as token:
                creds = pickle.load(token)
        # If there are no (valid) credentials available, let the user log in.
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    'drive_credentials.json', SCOPES)
                creds = flow.run_local_server(port=0)
            # Save the credentials for the next run
            with open('token.pickle', 'wb') as token:
                pickle.dump(creds, token)

        self.service = build('drive', 'v3', credentials=creds)

    def list_files_in_folder(self, folder_id=None):
        page_token = None
        files = []
        while True:
            response = self.service.files().list(q=f"'{folder_id}' in parents" if folder_id else None,
                                                  fields='nextPageToken, files(id, name, webContentLink)',
                                                  pageToken=page_token).execute()
            for file in response.get('files', []):
                files.append({"name": file.get("name"), "id": file.get("id"), "download": file.get("webContentLink")})
            page_token = response.get('nextPageToken', None)
            if page_token is None:
                break

        return files


def main():
    """Shows basic usage of the Drive v3 API.
    Prints the names and ids of the first 10 files the user has access to.
    """

    client = DriveClient()
    client.list_files_in_folder()

if __name__ == '__main__':
    main()
