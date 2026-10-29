import fitz, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
for i in range(35, 42):
    text = doc[i].get_text().encode('ascii','replace').decode('ascii')
    print(f'\n=== Page {i+1} ===')
    print(text)
    print('---')
