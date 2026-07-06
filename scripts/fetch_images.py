"""Fetch Wikipedia page images for all painters in painters.json
and download them to a local images/ directory.
Usage:
    python3 scripts/fetch_images.py
"""
import json
import time
import os
import re
import urllib.request
import urllib.parse
import urllib.error

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAINTERS_FILE = os.path.join(BASE_DIR, 'painters.json')
IMAGES_DIR = os.path.join(BASE_DIR, 'images')
BATCH_SIZE = 50
API_URL = 'https://en.wikipedia.org/w/api.php'


def sanitize_filename(name):
    """Turn a painter name into a safe filename."""
    s = name.lower()
    s = re.sub(r'[^a-z0-9]+', '_', s)
    s = s.strip('_')
    return s[:80]


def download_image(url, filepath):
    """Download image from url to filepath. Return True on success."""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'PainterList/1.0 (painter catalog; contact@example.com)'
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            with open(filepath, 'wb') as f:
                f.write(resp.read())
        return True
    except Exception as e:
        print(f"    Download failed: {e}")
        return False


def main():
    os.makedirs(IMAGES_DIR, exist_ok=True)

    with open(PAINTERS_FILE) as f:
        painters = json.load(f)

    remaining = [p for p in painters if 'image_url' not in p or 'image_path' not in p]
    if not remaining:
        print("All painters already processed. Nothing to do.")
        return

    total = len(painters)
    print(f"Processing {total} painters...")

    for start in range(0, total, BATCH_SIZE):
        batch = painters[start:start + BATCH_SIZE]
        titles = [p['name'] for p in batch]

        # --- Step 1: Fetch image URLs from Wikipedia API ---
        params = urllib.parse.urlencode({
            'action': 'query',
            'prop': 'pageimages',
            'pithumbsize': 200,
            'titles': '|'.join(titles),
            'redirects': 1,
            'format': 'json',
            'origin': '*'
        })
        url = f'{API_URL}?{params}'

        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = json.loads(resp.read())

            redirect_map = {}
            for r in data.get('query', {}).get('redirects', []):
                redirect_map[r['from']] = r['to']

            title_thumb = {}
            for page_id, page_data in data.get('query', {}).get('pages', {}).items():
                if page_id == '-1':
                    continue
                title = page_data.get('title', '')
                thumb = page_data.get('thumbnail')
                if thumb:
                    title_thumb[title] = thumb['source']

            for painter in batch:
                name = painter['name']
                img_url = title_thumb.get(name) or title_thumb.get(redirect_map.get(name))
                if img_url:
                    painter['image_url'] = img_url

        except Exception as e:
            print(f"  Batch API call failed: {e}")

        # --- Step 2: Download images for this batch ---
        for painter in batch:
            img_url = painter.get('image_url')
            if not img_url:
                continue

            # Determine file extension from URL
            ext = os.path.splitext(urllib.parse.urlparse(img_url).path)[1]
            if not ext or ext.lower() not in ('.jpg', '.jpeg', '.png', '.gif', '.webp'):
                ext = '.jpg'

            safe_name = sanitize_filename(painter['name'])
            filename = f"{painter['id']:04d}_{safe_name}{ext}"
            filepath = os.path.join(IMAGES_DIR, filename)

            if os.path.exists(filepath):
                painter['image_path'] = filepath
                continue

            if download_image(img_url, filepath):
                painter['image_path'] = filepath
                print(f"    Downloaded: {filename}")
            else:
                # Remove invalid URL so retry re-fetches
                painter.pop('image_url', None)

        time.sleep(0.5)

        # --- Progress ---
        with_url = sum(1 for p in painters if 'image_url' in p)
        with_file = sum(1 for p in painters if 'image_path' in p)
        done = min(start + BATCH_SIZE, total)
        print(f"  {done}/{total} — {with_url} URLs, {with_file} files downloaded")

    # Save updated JSON
    with open(PAINTERS_FILE, 'w') as f:
        json.dump(painters, f, ensure_ascii=False, indent=2)

    with_url = sum(1 for p in painters if 'image_url' in p)
    with_file = sum(1 for p in painters if 'image_path' in p)
    print(f"\nDone. {with_url}/{total} painters with image_url, {with_file} files in {IMAGES_DIR}/")


if __name__ == '__main__':
    main()
