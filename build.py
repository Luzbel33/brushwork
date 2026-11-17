"""Pack the studio into a single HTML file using only the Python standard library."""
import argparse
import base64
import hashlib
import json
import mimetypes
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SAMPLE = "sample/chelsea.png"
SCRIPTS = ("locales.js", "brush.js", "painting-worker.js", "timeline.js", "player.js")
ICONS = ("mark.svg", "favicon.ico", "touch-icon.png")
ASSETS = (*SCRIPTS, *ICONS, "studio.css")
ASSET_LINK = re.compile(r'((?:src|href)=")(' + "|".join(map(re.escape, ASSETS)) + r')(?:\?v=[0-9a-f]+)?"')


def refresh_assets():
    index = ROOT / "index.html"
    versions = {}
    for asset in ASSETS:
        path = ROOT / asset
        data = path.read_bytes() if path.suffix in (".png", ".ico") else path.read_text(encoding="utf-8").encode("utf-8")
        versions[asset] = hashlib.sha256(data).hexdigest()[:12]
    template = index.read_text(encoding="utf-8")
    html = ASSET_LINK.sub(lambda m: f'{m[1]}{m[2]}?v={versions[m[2]]}"', template)
    if html != template:
        with index.open("w", encoding="utf-8", newline="\n") as out:
            out.write(html)


def data_url(image):
    mime = mimetypes.guess_type(image.name)[0] or "application/octet-stream"
    return "data:" + mime + ";base64," + base64.b64encode(image.read_bytes()).decode("ascii")


def configure(template, reference, settings=None):
    config = ""
    if settings:
        literal = json.dumps(settings, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
        config = "<script>window.BrushworkConfig=" + literal + ";</script>"
    return template.replace(SAMPLE, reference).replace("<!--CONFIG-->", config)


def pack(output, image=ROOT / SAMPLE, settings=None):
    template = (ROOT / "index.html").read_text(encoding="utf-8")
    template = ASSET_LINK.sub(r'\1\2"', template)
    html = configure(template, data_url(image), settings)
    # Sharing cards describe the hosted sample. A portable file may contain a different photo.
    html = re.sub(r'^  <meta (?:property="og:|name="twitter:).*?\n', "", html, flags=re.M)
    for asset in ICONS:
        html = html.replace(f'"{asset}"', '"' + data_url(ROOT / asset) + '"')
    css = (ROOT / "studio.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="studio.css">', "<style>" + css + "</style>")
    for script in SCRIPTS:
        source = (ROOT / script).read_text(encoding="utf-8")
        source = re.sub(r"</script", r"<\\/script", source, flags=re.I)
        html = html.replace(f'<script src="{script}"></script>', "<script>" + source + "</script>")
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    html += "\n<!--\n" + license_text + "\n-->\n"
    tmp = output.with_suffix(".part")
    tmp.write_text(html, encoding="utf-8")
    tmp.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "Brushwork.html")
    parser.add_argument("--refresh-assets", action="store_true", help="Update the public page's asset versions after editing the studio")
    args = parser.parse_args()
    if args.refresh_assets:
        refresh_assets()
    else:
        pack(args.output)
