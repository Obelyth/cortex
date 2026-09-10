export interface ConsoleRoutePath {
  root: string;
  segments: string[];
}

/** Parse the concrete `/s/[secret]/console` route without inspecting the secret's text. */
export function consoleRoutePath(pathname: string): ConsoleRoutePath | null {
  const match = pathname.match(/^(\/s\/[^/]+\/console)(?:\/(.*))?$/);
  if (!match) return null;
  return {
    root: match[1],
    segments: (match[2] ?? "").split("/").filter(Boolean),
  };
}
