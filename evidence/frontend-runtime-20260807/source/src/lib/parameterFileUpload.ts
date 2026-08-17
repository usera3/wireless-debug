export interface ParameterUploadRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: FormData;
}

/** Build the browser-native multipart request accepted by the cloud proxy. */
export async function buildParameterUploadRequest(
  url: string,
  file: File,
): Promise<ParameterUploadRequest> {
  const body = new FormData();
  body.append('file', file, file.name);
  return {
    url,
    method: 'POST',
    headers: {},
    body,
  };
}
