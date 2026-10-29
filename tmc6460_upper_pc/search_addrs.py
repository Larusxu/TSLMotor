import fitz, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
# Search for key register addresses in the register detail pages
keywords = ['0x155', '0x121', '0x111', 'PID_POSITION_ACTUAL', 'PID_VELOCITY_ACTUAL', 'PID_TORQUE_FLUX_ACTUAL']
for kw in keywords:
    print(f'\n=== {kw} ===')
    for i in range(len(doc)):
        text = doc[i].get_text().lower()
        if kw.lower() in text:
            snippet = text[max(0,text.lower().find(kw.lower())-50):text.lower().find(kw.lower())+200]
            snippet = snippet.replace('\n',' ').encode('ascii','replace').decode('ascii')
            name = 'P'+str(i+1) if not text[:20].strip().startswith(('0x','bits')) else text[:60].replace('\n',' ')
            print(f'  P{i+1}: ...{snippet[:200]}...')
