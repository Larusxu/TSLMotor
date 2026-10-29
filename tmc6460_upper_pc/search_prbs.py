import fitz
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
# Page 83-85: PRBS identification modes
for i in [82, 83, 84, 162, 163]:
    text = doc[i].get_text()
    print(f'\n=== Page {i+1} ===')
    print(text)
    print('---')
