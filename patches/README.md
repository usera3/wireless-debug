# Managed component patches

ESP-IDF downloads `espressif/esp_websocket_client` into the Git-ignored
`managed_components/` directory. The verified firmware adds read-only TX timing
diagnostics to version 1.7.0 of that component.

After `idf.py reconfigure` or any operation that recreates managed components,
apply the patch from the project root before building:

```sh
patch -p1 -d managed_components/espressif__esp_websocket_client \
  < patches/esp_websocket_client_tx_diagnostics.patch
```

The expected pristine component hash is recorded in
`managed_components/espressif__esp_websocket_client/.component_hash` as
`3fb288702517ef4d75bf933a115f1056ee0c2540d964f9e1d856e0bb67e1dfeb`.
