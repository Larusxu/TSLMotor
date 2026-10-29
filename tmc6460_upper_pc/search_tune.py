import fitz
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
# 搜索电机参数辨识、自整定、auto-tuning、identification 等关键词
keywords = ['auto.tun', 'autotun', 'auto.tune', 'identification', 'parameter identification', 'motor identification', 'auto.calibrat', 'self.tun', 'R_sense', 'motor R', 'motor L', 'motor resistance', 'motor inductance', 'flux linkage', 'Ke', 'Kt', 'measur.*resistance', 'measur.*inductance', 'open.loop', 'open loop.*mode', 'open loop.*motion']
for i in range(len(doc)):
    text = doc[i].get_text()
    lower = text.lower()
    found = []
    for kw in keywords:
        import re
        if re.search(kw.lower(), lower):
            found.append(kw)
    if found:
        print(f'\n=== Page {i+1} (found: {", ".join(found)}) ===')
        # Print relevant lines
        for line in text.split('\n'):
            line_lower = line.lower()
            for kw in keywords:
                if re.search(kw.lower(), line_lower):
                    print(line.strip())
                    break
