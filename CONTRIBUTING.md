# Contributing to Museamo

Start with the [README](README.md) and [development guide](docs/development.md). The [architecture](docs/architecture.md) and [design system](DESIGN.md) explain the native storage boundaries and interaction rules.

For a bug report, include the app version, Android/Windows version, steps to reproduce, and what you expected. Use sample thoughts in screenshots. Remove personal text, locations, backup contents, and device addresses from attachments.

For a proposed feature, describe the problem it solves and how it fits a private, quick-capture library. Open an issue before a large change.

Keep changes focused. Run the relevant checks from the development guide; include what passed and what still needs a physical device. Native persistence and sync changes need native tests, and UI changes should include screenshots in both themes. Use disposable data for experiments.

Contributions are provided under [AGPLv3](LICENSE). Preserve the licenses of bundled fonts and other third-party assets. Release builds and signing happen locally; see [releases](docs/releases.md).
