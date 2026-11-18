#!/usr/bin/env node
// jetcode: thin shim over the opencode CLI loader. Keeps the binary name
// "jetcode" on PATH, forwards to the normal cached launcher.
require("./opencode.cjs")
