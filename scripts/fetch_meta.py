import json, time, urllib.request, concurrent.futures as cf, sys
base='/home/claude/steam/'
games={}
for f in ['owned.json','kostya.json']:
    for g in json.load(open(base+f))['response']['games']:
        games[g['appid']]=g['name']
def get(u):
    for i in range(3):
        try:
            with urllib.request.urlopen(u,timeout=20) as r: return json.load(r)
        except Exception as e: time.sleep(2)
    return None
def one(a):
    s=get(f'https://steamspy.com/api.php?request=appdetails&appid={a}') or {}
    ach=get(f'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={a}') or {}
    p=[float(x['percent']) for x in ach.get('achievementpercentages',{}).get('achievements',[])]
    tags=s.get('tags') or {}
    if isinstance(tags,list): tags={}
    return a,{'name':games[a],'tags':list(tags.keys())[:20],'median':s.get('median_forever',0),'average':s.get('average_forever',0),
             'pos':s.get('positive',0),'neg':s.get('negative',0),'ach':sorted(p)}
out={}
with cf.ThreadPoolExecutor(4) as ex:
    for i,(a,m) in enumerate(ex.map(one,list(games))):
        out[a]=m
        if i%40==0: print(i,flush=True)
json.dump(out,open(base+'meta.json','w'),ensure_ascii=False)
print('done',len(out))
