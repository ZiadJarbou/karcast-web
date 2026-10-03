# Android Auto presentation and video transport

The content and native bottom dock use the same uniform scale: min(viewportWidth / sourceWidth, viewportHeight / sourceHeight). The dock stays flush with the page bottom. Content is centered in the original frame's fitted rectangle. A mismatched viewport may have black margins; images and icons are never stretched to remove them. Touch mapping uses these actual rectangles and rejects taps in their margins.

The verified native profile is 1280×720 at 256 dpi: 592 pixels of content and a 128-pixel horizontal dock. Profiles with another dock orientation or height are outside this split's scope.

Browsers with WebCodecs default to Android Auto's original H.264 over an ordered, reliable WebRTC data channel named karcast-video. This bypasses libwebrtc's video capturer and encoder adaptation, which could discard reference frames in the previous passthrough pipeline. A single browser decoder supplies both canvases. The phone does no local decoding or re-encoding for this transport. The tesla-touch channel still carries input and refresh requests.

Each binary data-channel message has a 24-byte big-endian header: KC, version 2, flags (config=1, keyframe=2), uint32 access-unit ID, uint16 fragment index, uint16 fragment count, uint64 timestamp in microseconds, uint32 complete access-unit length, then up to 16000 bytes of Annex-B H.264. Units are limited to 2 MiB. The browser validates ordered fragment assembly before decoding. Android bounds the outgoing queue and slows the producer rather than silently dropping dependent pictures. A stalled queue closes the channel so the browser can use the secure relay fallback.

The secure WebSocket relay retains its version-1 12-byte packet format and uses the same browser decoder and layout. Explicit ?transport=relay selects it. ?transport=webrtc selects legacy RTP playback; ?transport=auto retains legacy RTP with relay fallback. Browsers without WebCodecs retain RTP playback. The raw path requires KarCast 2.0.18 or later; an older APK falls back after the direct startup timeout.

Refresh requests replay cached SPS/PPS and a complete GOP without replacing the peer connection. A two-second rendered-output watchdog requests refresh when input is advancing. Static screens alone do not cause reconnects. Native video-channel resources are released with their owning peer.

All six integration, relay, recovery and pairing test scripts pass. Fragment assembly tests cover split units and inconsistent lengths. Presentation and touch checks cover 930×720, 1280×720, 1600×600 and 600×900. A real Chrome render using recorded Android Auto frames confirmed uniform proportions and a bottom-aligned dock. Real-device playback and thermal results are recorded in the Android repository's performance notes. An in-car Tesla browser check remains necessary.
