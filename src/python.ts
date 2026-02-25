function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildSportsSkillsRepairCommand(
  pythonPath: string,
  userInstall = false
): string {
  const userFlag = userInstall ? " --user" : "";
  return `${shellQuote(pythonPath)} -m pip install --upgrade${userFlag} sports-skills`;
}
