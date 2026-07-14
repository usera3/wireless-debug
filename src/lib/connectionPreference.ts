interface InitialConnectionUrlOptions {
  remoteUrl: string | null;
  savedUrl: string | null;
  defaultUrl: string;
}

export function selectInitialConnectionUrl({
  remoteUrl,
  savedUrl,
  defaultUrl,
}: InitialConnectionUrlOptions): string {
  return remoteUrl?.trim() || savedUrl?.trim() || defaultUrl;
}
