"""Headless layout and file interactions; no desktop UI or hardware access."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

dest = Path(__file__).resolve().parents[1] / "reports/pose-ui-acceptance"
dest.mkdir(parents=True, exist_ok=True)
fixture = {"format": "teslahand.pose-sequence", "version": 1, "poses": [
    {"name": f"姿态{i:02}", "group": 1, "duration_ms": 1000,
     "motors": {"1": i*10, "15": 50, "16": 50}, "cylinders": {"1": 100+i}}
    for i in (1, 2)]}
with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://127.0.0.1:5185/")
    page.get_by_role("button", name="绝对位置", exact=True).click()
    page.get_by_role("button", name="一键找零", exact=True).wait_for()
    page.locator('input[type=file]').set_input_files({"name": "poses.json", "mimeType": "application/json", "buffer": json.dumps(fixture).encode()})
    page.get_by_role("cell", name="姿态01", exact=True).wait_for()
    assert page.locator("tr.is-linked").count() == 2
    assert page.get_by_role("button", name="执行", exact=True).count() == 2
    page.get_by_role('button', name='循环执行', exact=True).wait_for()
    page.get_by_label('每轮间隔（ms）', exact=True).fill('300')
    page.get_by_label('编辑姿态01别名', exact=True).dblclick()
    page.get_by_label('姿态01别名', exact=True).fill('张开')
    page.get_by_label('姿态01别名', exact=True).press('Enter')
    assert page.get_by_label('选择要插入的姿态').locator('option').count() == 1
    page.get_by_role('button', name='插入', exact=True).click()
    page.get_by_role('cell', name='姿态03', exact=True).wait_for()
    assert page.get_by_role('button', name='执行', exact=True).count() == 3
    page.get_by_label('姿态03执行后等待（ms）', exact=True).fill('200')
    fixture['round_interval_ms'] = 300
    fixture['poses'][0]['alias'] = '张开'
    fixture['poses'].append({**fixture['poses'][0], 'name': '姿态03', 'group': None, 'wait_ms': 200})
    page.get_by_role("button", name="导出 JSON", exact=True).click()
    page.get_by_role("alert").filter(has_text="请填写导出文件名").first.wait_for()
    page.get_by_label("文件名", exact=True).fill("动作验收")
    with page.expect_download() as pending:
        page.get_by_role("button", name="导出 JSON", exact=True).click()
    exported = pending.value
    assert exported.suggested_filename == "动作验收.json"
    exported.save_as(dest / "poses.json")
    saved = json.loads((dest / "poses.json").read_text(encoding="utf-8"))
    assert saved['poses'][0]['pose_id'] == saved['poses'][2]['pose_id']
    for pose in saved['poses']:
        pose.pop('pose_id')
    assert saved == fixture
    row = page.get_by_role('row').filter(has=page.get_by_role('cell', name='姿态01', exact=True))
    row.get_by_role('button', name='编辑', exact=True).click()
    assert 'is-editing' in row.get_attribute('class')
    slider = page.get_by_role('slider', name='M01-拇指微屈绝对位置', exact=True)
    assert float(slider.input_value()) == 10  # loading a row is passive
    slider.fill('35')
    page.get_by_label("文件名", exact=True).fill("保留草稿")
    page.get_by_role("button", name="运行日志", exact=True).click()
    page.get_by_role("button", name="绝对位置", exact=True).click()
    assert 'is-editing' in row.get_attribute('class')
    assert float(slider.input_value()) == 35
    assert page.get_by_label("文件名", exact=True).input_value() == "保留草稿"
    row.get_by_role('button', name='保存', exact=True).click()
    data = page.evaluate('JSON.parse(localStorage.getItem("tsl-pose-sequence-v1"))')
    assert data['poses'][0]['motors']['1'] == 35
    assert data['poses'][2]['motors']['1'] == 35  # inserted reference updated
    assert data['poses'][1]['motors']['1'] == 20  # unrelated row unchanged
    assert data['poses'][2]['wait_ms'] == 200
    labels = page.locator('.action-axis-name strong').all_text_contents()
    assert [s.split('-')[0] for s in labels[:16]] == ['M01','M04','M06','M03','M05','M02','M10','M13','M11','M12','M09','M14','M07','M08','M15','M16']
    with page.expect_download() as pending:
        page.get_by_role("button", name="转换 Python SDK", exact=True).click()
    pending.value.save_as(dest / "sequence.py")
    ast.parse((dest / "sequence.py").read_text(encoding="utf-8"))
    for width in (1440, 1120):
        page.set_viewport_size({"width": width, "height": 1000})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(dest / f"actions-{width}.png"), full_page=True)
    page.get_by_role("button", name="删除", exact=True).first.click()
    assert page.get_by_role("cell", name="姿态01", exact=True).count() == 0
    page.reload()
    page.get_by_role("button", name="绝对位置", exact=True).click()
    page.get_by_role("cell", name="姿态02", exact=True).wait_for()
    page.get_by_role("button", name="固件与烧录", exact=True).click()
    page.get_by_role("button", name="DFU 升级所选固件", exact=True).wait_for()
    page.screenshot(path=str(dest / "firmware.png"), full_page=True)
    assert not errors, errors
    print("PASS: headless import/export, Python conversion, persistent delete, linked rows, 1440/1120 layout, firmware page")
    browser.close()
