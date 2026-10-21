from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, random, math, json
ROOT=Path(__file__).resolve().parents[1]/'src'/'demo'
FONT=Path('C:/Windows/Fonts/msyh.ttc'); LATIN=Path('C:/Windows/Fonts/segoeuil.ttf')
def font(size,latin=False):return ImageFont.truetype(str(LATIN if latin else FONT),size)
def blend(a,b,t):return tuple(int(x*(1-t)+y*t) for x,y in zip(a,b))
PALETTES=[((33,60,95),(205,167,157),(53,82,115),(248,217,176)),((59,70,120),(207,152,188),(72,66,116),(255,225,191)),((30,76,82),(149,189,169),(35,91,93),(242,230,177)),((70,50,87),(222,145,146),(112,71,110),(255,226,184)),((18,39,76),(91,137,162),(29,65,94),(200,236,231)),((73,98,123),(223,208,191),(94,114,130),(255,242,220)),((59,51,90),(169,158,202),(72,66,109),(244,222,224)),((91,79,102),(220,181,155),(119,96,121),(255,231,194))]
def scene(seed,title,subtitle='',wide=False,transparent=False):
 rng=random.Random(seed); w,h=(1280,800) if wide else (840,1160)
 if transparent:
  im=Image.new('RGBA',(w,h));d=ImageDraw.Draw(im);cx=w//2
  d.ellipse((cx-105,h*.12,cx+105,h*.12+210),fill=(232,205,221,255));d.polygon([(cx-190,h*.87),(cx-120,h*.37),(cx+120,h*.37),(cx+190,h*.87)],fill=(91,85,137,255));d.polygon([(cx-140,h*.38),(cx-50,h*.33),(cx+40,h*.51),(cx+130,h*.37),(cx+152,h*.54),(cx+50,h*.67),(cx-135,h*.57)],fill=(168,160,199,255));d.ellipse((cx-110,h*.10,cx+110,h*.22),fill=(77,66,116,255));d.polygon([(cx-108,h*.19),(cx-137,h*.36),(cx-64,h*.33)],fill=(77,66,116,255));d.polygon([(cx+95,h*.19),(cx+140,h*.37),(cx+75,h*.32)],fill=(77,66,116,255));d.rounded_rectangle((cx-120,h*.86,cx-20,h*.96),radius=18,fill=(57,55,86,255));d.rounded_rectangle((cx+20,h*.86,cx+120,h*.96),radius=18,fill=(57,55,86,255));return im
 sky,low,mountain,sun=PALETTES[seed%len(PALETTES)]
 t=np.linspace(0,1,h)[:,None,None];arr=np.empty((h,w,3),dtype=np.uint8);arr[:]=np.clip(np.array(sky)[None,None,:]*(1-t)+np.array(low)[None,None,:]*t,0,255)
 noise=np.random.default_rng(seed).normal(0,.8,arr.shape);arr=np.clip(arr.astype(float)+noise,0,255).astype('uint8');im=Image.fromarray(arr);d=ImageDraw.Draw(im)
 # soft sun halo, stars and distant atmospheric streaks
 halo=Image.new('RGBA',(w,h));hd=ImageDraw.Draw(halo);sx=int(w*(.65 if seed%2 else .3));sy=int(h*.25);rad=int(w*.10)
 for i in range(12,0,-1):hd.ellipse((sx-rad-i*7,sy-rad-i*7,sx+rad+i*7,sy+rad+i*7),fill=(*sun,int(2+i/2)))
 halo=halo.filter(ImageFilter.GaussianBlur(12));im=Image.alpha_composite(im.convert('RGBA'),halo);d=ImageDraw.Draw(im)
 d.ellipse((sx-rad,sy-rad,sx+rad,sy+rad),fill=(*sun,245))
 if seed%3==0:d.ellipse((sx-rad*.45,sy-rad*1.2,sx+rad*1.25,sy+rad*.8),fill=(*blend(sky,low,.25),255))
 for i in range(55):
  x=rng.randrange(w);y=rng.randrange(int(h*.42));size=rng.choice([1,1,2]);d.ellipse((x,y,x+size,y+size),fill=(*blend(sky,(255,255,255),rng.uniform(.2,.7)),255))
 cloud=Image.new('RGBA',(w,h));cd=ImageDraw.Draw(cloud)
 for i in range(15):
  x=rng.randrange(-100,w);y=rng.randrange(int(h*.27),int(h*.55));cd.ellipse((x,y,x+rng.randint(120,500),y+rng.randint(5,30)),fill=(*sun,18))
 cloud=cloud.filter(ImageFilter.GaussianBlur(8));im=Image.alpha_composite(im,cloud);d=ImageDraw.Draw(im)
 for layer in range(5):
  ybase=h*(.48+layer*.085);pts=[(-30,h)];x=-30
  while x<w+30:
   yy=ybase+rng.uniform(-h*.13,h*.055);pts.append((x,yy));x+=rng.randint(45,130)
  pts.extend([(w+30,h)]);color=blend(low,mountain,.25+layer*.15);d.polygon(pts,fill=(*color,255))
  # illuminated sloping ridgelines
  if layer<3:d.line(pts[1:-1],fill=(*blend(color,sun,.11),255),width=2)
 # a winding luminous river
 pts=[]
 for i in range(80):
  y=h*.63+i/79*h*.37;xx=w*.51+math.sin(i*.045+seed)*w*.13+i*.9;pts.append((xx,y))
 for i in range(len(pts)-1):d.line((pts[i],pts[i+1]),fill=(*blend(sun,mountain,.5),255),width=max(1,int((i/79)**2*w*.09)))
 # architectural silhouettes or forest
 front=blend(mountain,(14,20,42),.5)
 if seed%2:
  x=0
  while x<w:
   bw=rng.randint(15,52);bh=rng.randint(20,140);base=h*.82+rng.randint(0,int(h*.10));d.rectangle((x,base-bh,x+bw,base+80),fill=(*front,255))
   if rng.random()<.5:d.line((x+bw*.5,base-bh,x+bw*.5,base-bh-30),fill=(*front,255),width=2)
   for yy in range(int(base-bh+10),int(base),14):
    for xx in range(int(x+5),int(x+bw-3),10):
     if rng.random()<.38:d.rectangle((xx,yy,xx+2,yy+3),fill=(*blend(sun,front,.35),190))
   x+=bw+6
 else:
  for i in range(29):
   x=rng.randrange(w);base=rng.uniform(h*.84,h);th=rng.uniform(h*.09,h*.22);tw=th*.26;d.rectangle((x-2,base-th,x+2,base),fill=(*front,255))
   for j in range(4):d.polygon([(x,base-th+j*th*.13),(x-tw*(j+1)/4,base-th+j*th*.13+th*.5),(x+tw*(j+1)/4,base-th+j*th*.13+th*.5)],fill=(*front,255))
 # softly vignette and intentional photographic border typography
 shade=Image.new('RGBA',(w,h));sd=ImageDraw.Draw(shade)
 for i in range(int(h*.35)):sd.line((0,h-1-i,w,h-1-i),fill=(12,17,32,int(180*(1-i/(h*.35)))))
 im=Image.alpha_composite(im,shade);d=ImageDraw.Draw(im)
 margin=int(w*.09);d.text((margin,int(h*.075)),'ORIGINAL  /  LANDSCAPE STUDY',font=font(int(w*.018),True),fill=(247,240,242,200));d.line((margin,int(h*.11),margin+35,int(h*.11)),fill=(249,220,231,180),width=2)
 d.text((margin,int(h*.82)),title,font=font(int(w*.062)),fill=(251,244,242,245));d.text((margin,int(h*.90)),subtitle or 'THE MOMENTS WE KEEP',font=font(int(w*.022),True),fill=(239,226,232,195));d.text((w-margin-40,int(h*.92)),f'{seed%100:02}',font=font(int(w*.031),True),fill=(239,226,232,190))
 return im.convert('RGB')
def save(im,p):p.parent.mkdir(parents=True,exist_ok=True);im.save(p,quality=91)
groups=[('幻想与游戏（示例）',['云海来信','月下旅人','森林回声','赤色黄昏','星河边界','远方之城','紫罗兰之夜','风的归处','雨后物语','白昼尽头','群山之间','长夏未央']),('动画与映画（示例）',['银河慢行','落日放映室','夏日序曲','夜航日记','海岸线']),('漫画与设定（示例）',['山野手记','旅途速写','幻想档案','城市画集'])]
manifest=[]
for gi,(group,titles) in enumerate(groups):
 root=ROOT/group;save(scene(gi*10+1,group.replace('（示例）',''),'SHIGUANG / DEMO COLLECTION',True),root/(group+'.jpg'))
 for i,title in enumerate(titles):
  seed=gi*20+i+1;album=root/f'{i+1:02} {title}';covername=(album.name+'.jpg') if i%3==2 else '00 封面.jpg';save(scene(seed,title,f'VOLUME {i+1:02} / ORIGINAL STUDY'),album/covername)
  for j in range(1,5):save(scene(seed+j,title,f'LANDSCAPE {j:02} / DEMO',True),album/f'{j:02} 场景.jpg')
  if i<2:
   save(scene(seed+8,title,'WORLD BUILDING',True),album/'设定集'/'01 场景与建筑'/'远景.jpg');save(scene(seed,title,transparent=True),album/'设定集'/'02 透明人物'/'透明角色.png')
  manifest.append(str(album))
(ROOT/'示例说明.txt').write_text('本目录为拾光相册生成的示例图库。作品名称、风景与人物均为程序演示素材，不代表真实 Bangumi 条目。可从资料库移除分类；不影响你的真实图片。\n',encoding='utf-8')
print(json.dumps({'albums':len(manifest),'files':len(list(ROOT.rglob('*.*'))),'path':str(ROOT)},ensure_ascii=False))
