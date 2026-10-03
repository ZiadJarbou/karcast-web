# Full-height Android Auto presentation

The browser expands Android Auto's content area to fill all space above the native bottom dock, removing the page's top and bottom letterboxing. The dock stays flush with the page bottom and scales uniformly with the display width, keeping its icons round. Extremely wide/short windows limit dock height to 40% of the viewport so the content area remains usable.

This uses KarCast 2.0.16's verified 1280×720, 256-dpi profile: the native dock occupies the bottom 128 pixels, with 592 pixels of content above it. The normalized split follows WebRTC resolution adaptation. The browser presents every part of the native frame; the top and dock use different vertical scales when the viewport aspect ratio differs. Other native profiles with a different dock orientation/height are outside this profile's scope.

WebRTC playback uses two views of the same received MediaStream track and one peer connection. Secure relay playback uses the existing single H.264 decoder, drawing its output into the content canvas and its bottom strip into the dock canvas. There is no added encoder, frame-reset timer, or JavaScript video redraw loop. Touch events from either section map back to the correct original native coordinates, including during resize and captured drags.

Validation: all existing integration/load, relay, performance/recovery and Tesla fallback tests pass. Pointer-handler checks cover content/dock mapping across 930×720, 1280×720, 1600×600 and 600×900 viewports, both transports, outside taps, shared track ownership, and cleanup. A real headless Chrome render using recorded native Android Auto map/dock frames confirmed adjacent sections, the dock flush with the viewport bottom, and preserved dock proportions at all four sizes. This is a browser fixture check; in-car Tesla appearance still needs a live refresh.

Only the website changes; the installed 2.0.16 APK already provides the required native profile. CSS and JavaScript asset URLs are versioned together to refresh cached clients.
