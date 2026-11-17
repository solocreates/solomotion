# Changelog

Every release of SoloMotion, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The notes of each GitHub Release
start from the section with its version.

## 1.0.0-beta.2

SoloMotion on the desktop.

### Added

- Desktop apps for macOS, Windows and Linux. They open the live studio, keep
  working offline, open `solomotion://` links and update themselves from this
  repository's releases. The builds are unsigned for now; the release notes say
  how to open them on each system.

### Fixed

- Next.js 16.4.6, which closes two `use cache` advisories
  (GHSA-mfr8-8qww-v76h, GHSA-vc7v-qv4w-wrv8).

## 1.0.0-beta.1

The first public pre-release.

### Added

- The SoloMotion theme system, `@solomotion/theme`: one validated theme file sets
  the colours, type, shape and the way each control is drawn, with import and
  export as JSON.
