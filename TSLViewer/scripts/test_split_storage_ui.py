"""Headless storage presentation checks; no serial connection or desktop UI."""
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path('doc/moto_evidence/split-storage')
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='msedge')
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:5183')
    page.get_by_role('button', name=re.compile('板载存储')).click()
    assert page.get_by_text('主控 W25 配置档案', exact=True).is_visible()
    assert page.get_by_role('button', name='读取公共配置').is_disabled()
    assert page.get_by_role('button', name='自检（写读 0xFE）').count() == 0
    assert page.get_by_role('button', name='读取全部 256 B').count() == 0
    page.get_by_label('连接模式', exact=True).select_option('main485')
    page.get_by_role('button', name='连接', exact=True).click()
    page.get_by_role('button', name='读取公共配置', exact=True).click()
    assert page.get_by_role('status').filter(has_text='浏览器演示不会模拟保存成功').is_visible()
    for width in (1440, 800):
        page.set_viewport_size({'width': width, 'height': 1000})
        page.screenshot(path=str(out / f'storage-{width}.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.get_by_role('button', name=re.compile('机械找零')).first.click()
    assert page.get_by_text('运动授权', exact=True).first.is_visible()
    expect(page.get_by_text(re.compile('浏览器预览不提供真实主控状态'))).to_be_visible()
    assert page.get_by_text('无新鲜反馈；不显示为 0 mA', exact=True).is_visible()
    for width in (1440, 800):
        page.set_viewport_size({'width': width, 'height': 1000})
        page.screenshot(path=str(out / f'semantic-{width}.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    browser.close()
print('PASS preview only: empty state, disabled direct/disconnected actions, obsolete EEPROM actions absent, browser rejects real storage, 1440/800 layouts')
