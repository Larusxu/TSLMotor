"""UI preview regression; starts no serial/CAN connection. Run Vite first."""
from pathlib import Path
from playwright.sync_api import sync_playwright
out=Path('doc/moto_evidence');out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='msedge')
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://localhost:5183')
    page.get_by_label('连接模式',exact=True).select_option('main485')
    page.get_by_label('电机',exact=True).select_option('16')
    page.get_by_role('button',name='连接',exact=True).click()
    page.get_by_role('button',name='读取 16 路映射',exact=True).click()
    page.wait_for_timeout(1200)
    halves=page.locator('.map-split table')
    assert halves.count()==2, halves.count()
    assert halves.nth(0).locator('tbody tr').count()==8
    assert halves.nth(1).locator('tbody tr').count()==8
    assert halves.nth(0).locator('thead th').all_inner_texts()==['电机','主控 UART','逻辑供电','TMC']
    assert page.get_by_role('row').count()==18, page.get_by_role('row').count()
    assert page.get_by_label('连接模式',exact=True).is_disabled()
    assert page.locator('button.enable-pill').count()==1
    page.screenshot(path=str(out/'main485.png'),full_page=True)
    page.get_by_role('button',name='断开',exact=True).click()
    page.get_by_label('连接模式',exact=True).select_option('maincan')
    page.set_viewport_size({'width':1120,'height':800})
    page.wait_for_timeout(120)
    assert page.get_by_role('row').count()==0
    page.screenshot(path=str(out/'maincan_1120.png'),full_page=True)
    assert not errors,errors
    browser.close()
print('PASS UI: modes, M16, connect lock, 8+8 mapping halves, TMC column, enable pill, disconnect clears table; preview only')