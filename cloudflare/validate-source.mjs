import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const adminSource = read("./admin-page.js");
const adminFactorySource = adminSource.replace("export function adminPage()", "function adminPage()");
const adminFactory = new Function(adminFactorySource + "\nreturn adminPage;");
const adminHtml = adminFactory()();
const adminScript = adminHtml.match(/<script>([\\s\\S]*?)<\\/script>/);
if (!adminScript) throw new Error("Admin page inline script was not found");
new Function(adminScript[1]);

for (const path of ["../index.html", "../game.html", "../appeal-app.html"]) {
  const html = read(path);
  const scripts = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)]
    .map((match) => match[1])
    .filter((code) => code.trim() && !code.includes('"@context"'));
  for (const code of scripts) new Function(code);
  console.log(path + ": " + scripts.length + " inline script(s) valid");
}

console.log("Admin inline script: valid");
