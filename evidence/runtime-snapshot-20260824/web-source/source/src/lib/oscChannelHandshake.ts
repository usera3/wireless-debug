export type OscChannelConfigureMode = 'serial' | 'parallel';

export async function configureOscChannels(
  requests: readonly Uint8Array[],
  mode: OscChannelConfigureMode,
  sendAndWait: (request: Uint8Array) => Promise<unknown>,
): Promise<void> {
  if (mode === 'parallel') {
    await Promise.all(requests.map((request) => sendAndWait(request)));
    return;
  }

  for (const request of requests) await sendAndWait(request);
}
