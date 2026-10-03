# Video recovery improvement

The public playback test showed 18 recovery events in a little over three
minutes. A recent phone status update could trigger a replay even though all
received pictures had rendered. Replaying a long cached GOP repeatedly made
rendered-frame counts grow much faster than the phone's source-frame count.

The browser now tracks pictures submitted but not output by WebCodecs. A static
screen and layout/config/status messages do not count as stalled decoding. Each
new picture gets its own two-second render deadline. Actual decoder stalls clear
only decoder work, preserve pairing and the peer, and request a reference chain
with a five-second recovery cooldown.

Cached and live H264 pictures share an ordered queue. At most eight pictures are
submitted to the decoder; the waiting queue is bounded at 20 MiB and 4096 units.
Overflow requests a new reference chain instead of silently dropping dependency
pictures. Generation checks close stale outputs without painting them.

Source progress without incoming access units requires eight seconds of sustained
starvation and at least three newer phone frames before requesting recovery.
Signaling heartbeats run every ten seconds, and diagnostics distinguish video
recoveries, pending pictures, queue bytes, and signaling reconnects.

The Android APK, original-H264 transport, native negotiated layout and touch
mapping remain unchanged. The prior fast baseline tag remains available.

Validation: npm test passes all six suites, including real HTTP/WebSocket
integration, 100-session concurrency, pairing isolation, reconnect preservation,
and asynchronous video regressions for static screens, stalled output, complete
GOP draining, stale callbacks, sustained starvation, and queue overflow.

Live deployment verification is recorded separately after publication.
