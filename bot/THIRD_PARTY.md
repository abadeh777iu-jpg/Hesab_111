# Third-party components

## Audio encoder

WAV/PCM-to-MP3 conversion uses the unmodified `@breezystack/lamejs` **1.2.7** package (LGPL-3.0, per its package metadata), a pure-JavaScript port/fork of LAME:

- Package: https://www.npmjs.com/package/@breezystack/lamejs/v/1.2.7
- Corresponding package source and build instructions: https://github.com/shijinyu/lamejs
- Original JavaScript port: https://github.com/zhuker/lamejs
- LAME: https://lame.sourceforge.io/

The upstream notice is retained in `licenses/lamejs-NOTICE.txt`; license texts are in `licenses/LGPL-3.0-only.txt` and `licenses/GPL-3.0-only.txt`. The original package and its notice remain in `node_modules/@breezystack/lamejs` after installation. No changes to the encoder itself are made in this repository. Our WAV validation/conversion wrapper is `audio.mjs`.

This repository supplies the bot source, exact dependency version/lockfile, and build configuration so the library can be inspected, modified or replaced and the Worker rebuilt. Run `npm ci`, edit/replace the encoder or point its dependency at your modified compatible package, then run `npm run test:bot` and `npm run bot:cf:check` (or `npm run bot:cf:deploy` for your own Worker). No technical restriction is added against modifying the library or reverse engineering the combined work to debug such modifications. Retain the required license notices when redistributing a bundle containing this library.

The encoder performs only local audio encoding. It does not synthesize speech, train/clone a voice, contact another service, or write audio to disk. The selected speech provider (by default OpenRouter routing to Google; optionally Free.ai) generates the synthetic voice; its voice/model terms apply separately.


## RSS XML parsing

News parsing uses pinned `fast-xml-parser` **5.12.0** (MIT), with its dependency versions fixed by `package-lock.json`. Source: https://github.com/NaturalIntelligence/fast-xml-parser . Its MIT notice is retained in `licenses/fast-xml-parser-MIT.txt`; dependency licenses are included in their installed npm packages. Our wrapper rejects DTD/entities, bounds feed size/depth/item count, and reads only selected public RSS fields. The development-only `esbuild` **0.28.2** bundles the real parser for workerd regression tests; it is not a news service.


## Public channel HTML parsing

Fars' anonymous public channel page is parsed with pinned `htmlparser2` **12.0.0** (MIT), not evaluated as browser code. Source: https://github.com/fb55/htmlparser2 . The MIT notice is retained in `licenses/htmlparser2-MIT.txt`; transitive dependency versions are locked in `package-lock.json`, with their license files in installed npm packages. No cookies, browser automation, Telegram account session or login bypass are used. A bounded DOM walk reads original post text, the post's own timestamp and its permalink only.


## Public Instagram/music HTTP services

The Cloudflare Instagram feature independently implements a bounded HTTP client for public vxInstagram embeds (https://github.com/Lainmode/InstagramEmbed-vxinstagram) and the published no-key SongFinder recognition contract (https://github.com/songfinder-dev/songfinder/blob/main/js/src/client.ts). No upstream implementation code or media is vendored. Runtime attribution and disclosure are shown in the video caption and recognition reply. Availability, fair-use limits and provider policies remain external; see [INSTAGRAM.md](INSTAGRAM.md).
