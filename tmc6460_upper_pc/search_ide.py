import fitz
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
keywords = ['TMCL-IDE', 'TMCL IDE', 'TMCL_IDE', 'upper computer', 'GUI', 'software', 'tool', 'application', 'PC software', 'PC tool', 'configuration tool', 'evaluation', 'EVAL', 'TMCL']
for i in range(len(doc)):
    text = doc[i].get_text()
    lower = text.lower()
    found = []
    for kw in keywords:
        if kw.lower() in lower:
            found.append(kw)
    if found:
        print(f'\n=== Page {i+1} (keywords: {", ".join(found)}) ===')
        print(text[:1500])
        print('---')
