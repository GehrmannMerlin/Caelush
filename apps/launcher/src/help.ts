export const HELP_TEXT = `Caelush — local coding agent

Usage:
  caelush
  caelush --continue
  caelush -c
  caelush --resume
  caelush -r
  caelush --resume <SESSION_ID>
  caelush --print <PROMPT>
  caelush -p <PROMPT>
  caelush doctor
  caelush web

Options:
  -p, --print [PROMPT]              Run without the interactive terminal UI
      --output-format <FORMAT>      text, json, or stream-json (print only)
  -c, --continue                    Continue the most recent session
  -r, --resume [SESSION_ID]         Resume a session or open the picker
      web                         Start the local Production Web Host
  -h, --help                        Show this help
  -V, --version                     Show the product version
`;
