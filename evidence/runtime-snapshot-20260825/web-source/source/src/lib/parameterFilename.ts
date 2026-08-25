/**
 * SPIFFS allows 31 bytes for the complete object path. The parameter tables
 * live below /excel/, which consumes 7 bytes, leaving 24 bytes for the name.
 * The local uploader sends encodeURIComponent(file.name) in X-Filename, so
 * the transport length is the value that must be checked here.
 */
export const ESP_PARAMETER_FILENAME_MAX_BYTES = 24;

export function getEspParameterFilenameTransportLength(fileName: string): number {
  return encodeURIComponent(fileName).length;
}

export function isEspParameterFilenameSupported(fileName: string): boolean {
  return getEspParameterFilenameTransportLength(fileName) <= ESP_PARAMETER_FILENAME_MAX_BYTES;
}
