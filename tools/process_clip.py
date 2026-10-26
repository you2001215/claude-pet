"""Green-screen clip -> transparent 640x360 VP9 webm, normalised like the pet's other clips.

usage: python3 process_clip.py in.mp4 out.webm [preview.png]
The first frame must be the standard standing pose: its head top / feet decide scale and position,
so every clip lines up (feet at 319,329; head-to-feet 258 px).
"""
import subprocess, sys
import numpy as np
from PIL import Image
from scipy import ndimage

SRC, DST = sys.argv[1], sys.argv[2]
PREVIEW = sys.argv[3] if len(sys.argv) > 3 else None
OW, OH, FEET_X, FEET_Y, CHAR_H = 640, 360, 319, 329, 258

probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate',
                        '-of', 'csv=p=0', SRC], capture_output=True, text=True).stdout.strip().split(',')
W, H = int(probe[0]), int(probe[1])
num, den = probe[2].split('/')
FPS = float(num) / float(den)
raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', SRC, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                     capture_output=True, check=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
print('frames', len(frames), W, H, FPS)

def key(rgb):
    a = rgb.astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    ge = g - np.maximum(r, b)                       # how much greener than the other channels
    alpha = np.clip((130 - ge) / (130 - 45), 0, 1)  # <=45 solid, >=130 background
    # drop specks that are not part of the character (compression noise, stray pixels)
    solid = alpha > 0.5
    lab, n = ndimage.label(solid)
    if n > 1:
        sizes = ndimage.sum(solid, lab, range(1, n + 1))
        keep = np.isin(lab, np.nonzero(sizes >= 300)[0] + 1)
        near = ndimage.binary_dilation(keep, iterations=3)
        alpha = np.where(near, alpha, 0)
    # despill: no pixel may stay greener than its other channels
    g2 = np.where(ge > 0, np.maximum(r, b), g)
    out = np.dstack([r, g2, b, (alpha * 255).round()]).clip(0, 255).astype(np.uint8)
    return out

first = key(frames[0])
m = first[..., 3] > 128
ys, xs = np.nonzero(m)
top, bottom = ys.min(), ys.max()
feet_rows = m[bottom - 30:bottom + 1]
fx = np.nonzero(feet_rows.any(axis=0))[0]
feet_x = (fx.min() + fx.max()) / 2
scale = CHAR_H / (bottom - top)
print(f'head top {top}, feet {bottom}, feet x {feet_x:.0f}, scale {scale:.4f}')
sw, sh = round(W * scale), round(H * scale)
ox, oy = round(FEET_X - feet_x * scale), round(FEET_Y - bottom * scale)

enc = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{OW}x{OH}', '-r', f'{FPS:g}',
                        '-i', '-', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-g', '48',
                        '-row-mt', '1', '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1', DST], stdin=subprocess.PIPE)
for i, fr in enumerate(frames):
    rgba = first if i == 0 else key(fr)
    im = Image.fromarray(rgba, 'RGBA').convert('RGBa').resize((sw, sh), Image.LANCZOS).convert('RGBA')
    canvas = Image.new('RGBA', (OW, OH), (0, 0, 0, 0))
    canvas.paste(im, (ox, oy))
    if PREVIEW and i == 0:
        bg = Image.new('RGBA', (OW, OH), (110, 130, 160, 255)); bg.alpha_composite(canvas); bg.save(PREVIEW)
    enc.stdin.write(np.array(canvas).tobytes())
enc.stdin.close()
enc.wait()
print('wrote', DST)
