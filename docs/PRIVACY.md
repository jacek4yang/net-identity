# Privacy

net-identity does not include telemetry, analytics, or remotely loaded program code.

## What is stored on this computer

| Data                                                                                      | Where                                       | How long                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Profiles (name, proxy host, username, location, timezone, WebRTC choice)                  | Firefox extension storage (`storage.local`) | Until you delete the profile or the extension |
| Proxy password                                                                            | Firefox session storage                     | Until Firefox exits                           |
| Active routing snapshot, including the password needed after the background page restarts | Firefox session storage                     | Until Firefox exits                           |

A password is not written into the saved profile. If one is found there, migration removes it.

## What leaves this computer

**Location lookup.** Activating or refreshing a profile can ask `https://ipwho.is/` where the current connection appears to come from. The request sends no cookies, no referrer, and no proxy password. A proxied profile shows that service the proxy's public address. Browser routing shows it your own public address, and only after you allow that collection in Firefox. Installing the extension does not create a profile, so a fresh install makes no such request. Coordinates from this lookup are approximate (about 20 km) and are not presented as GPS.

**Map pictures.** While the options page is open, it may request map images from `https://tile.openstreetmap.org/`. The image address reveals the area on screen. Images are requested with no referrer. The extension does not send the proxy password, the profile, or an account. Typed coordinates still work when those images cannot load. The map program itself is part of the extension.

**Proxy traffic.** Traffic you choose to send through a proxy goes to that proxy. The extension does not add its own analytics to that traffic.

## What pages can see

Pages receive the location and timezone of the active profile through compatibility shims. Those shims are visible to a page that inspects them. They are not a claim that the browser is anonymous or undetectable. A frame Firefox will not inject into can still see the computer's timezone and location.

## Your choices

- Do not activate a profile, and the extension does not contact the location service.
- Use a proxy profile when the location lookup should see the proxy's address.
- Use manual coordinates when you want to choose the place yourself.
- Deactivate the profile to stop the shims and release the WebRTC setting.
