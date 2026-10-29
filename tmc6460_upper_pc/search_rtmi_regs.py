import fitz, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
# Search for RTMI register addresses in register map section
keywords = ['0x344', '0x340', '0x034', 'RTMI_CH', 'UART.CONTROL', 'RTMI_EN', 'RTMI_SAMPLING', 'NORMAL_CRC_EN']
for kw in keywords:
    print(f'\n=== Searching: {kw} ===')
    for i in range(len(doc)):
        text = doc[i].get_text().lower()
        if kw.lower() in text:
            print(f'  Found on page {i+1}')
            # Print the relevant snippet
            idx = text.lower().find(kw.lower())
            start = max(0, idx - 100)
            end = min(len(text), idx + 200)
            snippet = text[start:end].replace('\n', ' ').encode('ascii','replace').decode('ascii')
            print(f'  Context: ...{snippet}...')
