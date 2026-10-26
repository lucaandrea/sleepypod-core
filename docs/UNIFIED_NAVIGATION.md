# Five shared destinations

The web shell follows the approved Tonight, Sleep, Autopilot, Home and More
order on phones and desktop. This matches the independently written native
`SleepTab` contract in `lucaandrea/free-sleep` at
`96e8a614956980d60a064c5d3816ef4f4b838989`. No native source is copied or changed.

| Destination | Routes and secondary controls |
| --- | --- |
| Tonight | `/[lang]`, existing temperature cards and 3D stage; routines at `/schedule`, configured base at `/base` |
| Sleep | `/sleep`, including its existing biometric and analysis views; `/data` remains a legacy entry |
| Autopilot | `/autopilot`, including rule editing, activity and diagnostics |
| Home | `/home`, bedroom input, MQTT and Apple Home setup |
| More | `/more`, a real setup hub; existing `/settings` and `/system` pages remain directly accessible |

The desktop rail expands the current destination. More keeps Settings and
System section links; Tonight keeps routines and configured base controls.
The phone bar has a stable five-item order regardless of base availability.
Both temperature views have a localized Routines shortcut. Existing direct
Settings routes and owner sign-out are preserved. The 3D toolbar uses its former
Settings slot for Routines; settings remain available from More and from the
standard page toolbar.

Legacy diagnostics routes `/sensors`, `/debug` and `/status` select More. The
matcher uses whole path segments, so unrelated prefixes do not select a tab.
Swipes use the same order and route ownership as the navigation; control
drags, dialogs, canvases and horizontal scrollers keep their gesture handling.

The bottom bar wraps links into rows and measures its actual height. Enlarged
text and safe-area padding reserve corresponding space in both the page and
the full-screen bed view. Every destination remains a keyboard-accessible link
with at least a 44-pixel touch height; selected phone links use `aria-current`.
Neutral light/dark tokens, the accessible temperature cards and reduced-motion
behavior remain in place.

## Scope and evidence

This change aligns navigation and entry points. It does not claim full visual
or feature parity: native HealthKit and model settings remain native features,
and the existing temperature and base renderers remain separate web views.
More describes those boundaries explicitly. No hardware command, persisted
schedule, authorization rule or API contract changes here.

Validation covers localized and legacy paths, nested desktop sections, unknown
routes, base visibility and swipe ownership. Production-browser workflows use
isolated authenticated fixture databases for all five destinations, old settings
links, routine access in both temperature views, owner sign-out, light/dark
screens, 320-pixel layout, enlarged text and keyboard navigation. The existing
offline 3D workflow verifies that rendering needs no internet asset download.
These checks are software evidence, not a deployment or physical qualification.
