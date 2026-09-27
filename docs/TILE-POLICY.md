# Location picker and tile policy

Decision checked on 2026-09-27 against the official
[OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/).

The standard service requires accurate identification. Web requests require a valid
Referer; native applications must identify themselves. It also requires caching,
visible attribution, and prohibits bulk or background downloading. The policy does
not explicitly exempt `moz-extension` pages from its identification requirements.
An extension page cannot rely on a normal website Referer, and inventing a website
origin would misrepresent the request. Removing a restrictive referrer policy alone
does not establish compliance.

Production therefore uses **no external tile provider**. `NO_TILES` supplies a local
coordinate grid, visibly labelled “Local coordinate grid · No map imagery”. There is
no OSM data in that grid, so it carries no misleading OSM attribution. There is no
tile credential, API key, remote code, background prefetch or third-party map request.
The picker works offline, including typed coordinates, marker selection, pan and zoom.
It does not provide street or geographic imagery.

`TileProvider` separates image URL generation, attribution and privacy description
from interaction state. Enabling a future network provider requires explicit terms
allowing extension/application use, a truthful identification method, licence
attribution and updated privacy/AMO documentation. Do not enable a public service just
because an unauthenticated URL happens to respond. The existing renderer requests
only visible tiles and retains failed URLs with bounded exponential backoff, so
pointer movement and resize cannot cause a retry storm.

The previous renderer recreated failed image elements on each render, started requests
even when the profile editor was hidden, and did not establish that a Referer was
actually sent. Its pointer state lacked cancellation, ignored automatic-mode panning,
and used final displacement to detect a click, making a returning drag select a point.
The replacement separates viewport, selection, zoom and gesture state and tests those
transitions directly and with real Firefox pointer/wheel actions.

These changes apply to a future release from main. They do not modify the v1.0.0
tag, submitted package or release record.
