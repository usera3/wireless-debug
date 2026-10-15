interface InitialConnectionUrlOptions {
  remoteUrl: string | null;
  savedUrl: string | null;
  defaultUrl: string | null;
  allowSavedUrl?: boolean;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

export function selectInitialConnectionUrl({
  remoteUrl,
  savedUrl,
  defaultUrl,
  allowSavedUrl = true,
}: InitialConnectionUrlOptions): string | null {
  const remote = clean(remoteUrl);
  if (remote) return remote;
  const saved = allowSavedUrl ? clean(savedUrl) : null;
  return saved || clean(defaultUrl);
}
