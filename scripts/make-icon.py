from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
root=Path(__file__).resolve().parents[1]
out=root/'src'/'assets';out.mkdir(parents=True,exist_ok=True)
# Read user artwork only. All generated assets are written into the application.
source=root/'新建文件夹'/'996-1.jpg'
im=ImageOps.fit(Image.open(source).convert('RGBA'),(1024,1024),method=Image.Resampling.LANCZOS)
mask=Image.new('L',(1024,1024));ImageDraw.Draw(mask).rounded_rectangle((6,6,1018,1018),radius=218,fill=255)
im.putalpha(mask);im.save(out/'app.png');im.save(out/'app.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
avatar=ImageOps.fit(Image.open(root/'新建文件夹'/'头像-topaz_small.png').convert('RGB'),(256,256),method=Image.Resampling.LANCZOS)
avatar.save(out/'avatar.webp',quality=90)
print('996 application icon and personal avatar generated:',out)
