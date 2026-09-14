---
"@opslane/sdk": patch
---

`setUser` now accepts user and account IDs as strings, safe integers, or bigints (the parameter type widens to match) and sends them as strings. A numeric ID used to make session registration fail, which turned off session recording for signed-in users, and error events arrived without the user. Numbers that are not safe integers, `0`, the strings `undefined` and `null`, and IDs over 256 characters are ignored, so pass large numeric IDs as strings. Changes to the identity object after `setUser` still apply, and `setUser` never throws.
