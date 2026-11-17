"""Pack the studio into a single HTML file using only the Python standard library."""
import argparse
import base64
import json
import mimetypes
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SAMPLE = "sample/chelsea.png"


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
    html = configure(template, data_url(image), settings)
    # Sharing cards describe the hosted sample. A portable file may contain a different photo.
    html = re.sub(r'^  <meta (?:property="og:|name="twitter:).*?\n', "", html, flags=re.M)
    for asset in ("mark.svg", "favicon.ico", "touch-icon.png"):
        html = html.replace(f'"{asset}"', '"' + data_url(ROOT / asset) + '"')
    css = (ROOT / "studio.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="studio.css">', "<style>" + css + "</style>")
    for script in ("locales.js", "brush.js", "painting-worker.js", "timeline.js", "player.js"):
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
    pack(parser.parse_args().output)
