import fitz
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
doc = fitz.open(r'G:\project\hand\Tesla_hand\tmc6460.pdf')
# 搜索 SSI 编码器配置相关寄存器
for i in range(len(doc)):
    text = doc[i].get_text()
    if 'SSI' in text and ('IO_MATRIX' in text or 'ENC_A' in text or 'encoder' in text.lower() or 'feedback' in text.lower() or 'PIN_' in text):
        print(f'\n=== Page {i+1} ===')
        print(text[:2500])
        print('---')
