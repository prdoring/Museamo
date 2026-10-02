# Licensing and public distribution

Museamo's original code is licensed under **AGPL-3.0-only**, with the complete terms in [LICENSE](../LICENSE). Copyright © 2026 prdoring and Museamo contributors. Commercial use is allowed; retain notices and provide corresponding source under the license when distributing covered derivatives or operating a modified network service.

The npm and Cargo manifests use the same license identifier. Release bundles include a source ZIP tied to the binary's commit. Third-party dependencies and assets retain their own licenses; Museamo's license does not replace them.

## Bundled assets

| Asset | License / source |
| --- | --- |
| DM Sans | SIL Open Font License; [notice](../public/fonts/OFL.txt) |
| Source Serif 4 | SIL Open Font License; [notice](../public/fonts/SourceSerif4-LICENSE.md) |
| Museamo lantern and custom vector wordmark | Original Museamo artwork; included under the repository license |
| Paper textures and pictograms | Imported from the maintainer's local design project; [inventory](paper-assets.md). Confirm underlying ownership and redistribution rights before publication. |
| Runtime/build dependencies | Their upstream licenses; exact versions are in `package-lock.json` and `Cargo.lock` |

Trailhead was removed from the current distributable files because its supplied personal-use license prohibited public sharing. Local originals remain in ignored `output/licensing/`. Older verification screenshots may show previous headings.

## Existing history

This repository was previously private. A previous Cargo manifest declared MIT; changing the current license does not revoke rights already granted to copies obtained under MIT.

The Trailhead binaries and notice are present in older Git commits. Deleting them from the current tree is insufficient to remove them from a public Git history. Before changing visibility, either confirm redistribution permission for those historical copies or prepare a separately reviewed history cleanup/fresh public repository. Also review history for secrets, private backups, and sample-data provenance. History rewriting and visibility changes are separate actions.

References: [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html), [GNU license FAQ](https://www.gnu.org/licenses/gpl-faq.html).
