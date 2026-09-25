"""Recreate the small, seamless ambient video used when the supplied CDN is unavailable.
Requires numpy and imageio-ffmpeg. All palette values originate in OKLCH.
"""
from pathlib import Path
import subprocess
import numpy as np
import imageio_ffmpeg


def oklch(l, c, h):
    a, b = c * np.cos(np.deg2rad(h)), c * np.sin(np.deg2rad(h))
    ll, mm, ss = (l + .3963377774*a + .2158037573*b)**3, (l - .1055613458*a - .0638541728*b)**3, (l - .0894841775*a - 1.291485548*b)**3
    linear = np.array([4.0767416621*ll - 3.3077115913*mm + .2309699292*ss, -1.2684380046*ll + 2.6097574011*mm - .3413193965*ss, -.0041960863*ll - .7034186147*mm + 1.707614701*ss])
    return np.clip(np.where(linear <= .0031308, 12.92*linear, 1.055*np.maximum(linear, 0)**(1/2.4)-.055), 0, 1)

w, h, fps, seconds = 640, 480, 24, 10
x, y = np.meshgrid(np.linspace(-1, 1, w), np.linspace(-1, 1, h))
colors = [oklch(.45, .22, 293), oklch(.43, .17, 263), oklch(.39, .09, 199)]
out = Path(__file__).resolve().parent.parent / 'src/assets/ambient-fallback.mp4'
p = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo', '-s', f'{w}x{h}', '-pix_fmt', 'rgb24', '-r', str(fps), '-i', '-', '-an', '-vcodec', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', str(out)], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
for i in range(fps*seconds):
    t = 2*np.pi*i/(fps*seconds)
    frame = np.zeros((h,w,3))
    blobs = [(-.65+.1*np.sin(t), -.25+.1*np.cos(t), .64, .74), (-.05+.14*np.cos(t), .15+.1*np.sin(t), .65, .7), (.7+.1*np.sin(t), .1+.15*np.cos(t), .56, .75)]
    for color, (cx,cy,sx,sy) in zip(colors, blobs):
        intensity = np.exp(-2*((x-cx)**2/sx**2+(y-cy)**2/sy**2))
        frame += intensity[:,:,None]*color
    p.stdin.write((np.clip(frame,0,1)*255).astype(np.uint8).tobytes())
p.stdin.close()
assert p.wait() == 0
print(f'Created {out} ({out.stat().st_size:,} bytes)')
