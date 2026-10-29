import fitz
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
# 搜索 IDE、上位机、evaluation board、EVAL 等关键词
keywords = ['TMCL-IDE', 'TMCL_IDE', 'TMCL IDE', 'Landungsbruecke', 'eval board', 'evaluation board', 'EVAL', 'evaluation kit', 'dev kit', 'development board']
for i in range(len(doc)):
    text = doc[i].get_text()
    found = []
    for kw in keywords:
        if kw.lower() in text.lower():
            found.append(kw)
    if found:
        print(f'\n=== Page {i+1} (found: {", ".join(found)}) ===')
        print(text[:2000])
        print('---')
