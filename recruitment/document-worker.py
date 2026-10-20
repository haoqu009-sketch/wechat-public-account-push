"""Offline, bounded document extraction. Input/output JSON on stdin/stdout; no network.

Native table cells are evidence. OCR text is only a review clue, never a verified row.
"""
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

sys.stdout.reconfigure(encoding='utf-8')

MAX_BYTES = 5_000_000
MAX_TEXT = 250_000
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def docx(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(e.file_size for e in entries) > 30_000_000:
            raise ValueError('Word解压体积超过上限')
        info = archive.getinfo('word/document.xml')
        if info.file_size > 8_000_000:
            raise ValueError('Word正文超过上限')
        xml = archive.read(info)
    if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
        raise ValueError('Word包含不允许的XML实体')
    root = ET.fromstring(xml)
    issues = []
    if any(entry.filename.startswith('word/media/') and entry.file_size > 30000 for entry in entries):
        issues.append('Word包含内嵌图片，其中文字尚未核对')
    if any(True for tag in ('ins', 'del', 'moveFrom', 'moveTo') for _ in root.iter(W + tag)):
        issues.append('Word存在修订，需对照最终发布稿')
        for parent in root.iter():
            for child in list(parent):
                if child.tag in (W + 'del', W + 'moveFrom'):
                    parent.remove(child)
    text = lambda el: ''.join(t.text or '' for t in el.iter(W + 't'))
    tables = []
    for number, table in enumerate(root.iter(W + 'tbl'), 1):
        # Nested tables cannot be flattened into the parent's qualification columns.
        if any(list(cell.iter(W + 'tbl')) for cell in table.iter(W + 'tc')):
            issues.append('Word存在嵌套表格，外层条件关系未自动合并')
            continue
        grid, previous = [], {}
        for row in table.findall(W + 'tr'):
            values, column = [], 0
            before = row.find(W + 'trPr/' + W + 'gridBefore')
            if before is not None:
                column = min(200, int(before.get(W + 'val', '0')))
                values.extend([''] * column)
            current = {}
            for cell in row.findall(W + 'tc'):
                span = cell.find(W + 'tcPr/' + W + 'gridSpan')
                width = int(span.get(W + 'val', '1')) if span is not None else 1
                if not 1 <= width <= 200 or column + width > 200:
                    raise ValueError('Word表格列数超过上限')
                merge = cell.find(W + 'tcPr/' + W + 'vMerge')
                value = text(cell)
                if merge is not None and merge.get(W + 'val') != 'restart':
                    value = previous.get(column, '')
                for offset in range(width):
                    values.append(value)
                    if merge is not None:
                        current[column + offset] = value
                column += width
            grid.append(values)
            previous = current
            if len(grid) > 10000:
                raise ValueError('Word表格行数超过上限')
        tables.append({'grid': grid, 'locator': f'Word表{number}', 'method': 'docx-cells'})
    body = root.find(W + 'body')
    paragraphs = [text(p) for p in body.findall(W + 'p')] if body is not None else []
    return {'tables': tables, 'pages': [{'number': 1, 'text': '\n'.join(paragraphs), 'notes': '\n'.join(paragraphs)}], 'issues': issues, 'method': 'docx-cells'}


def ocr_image(image, enabled):
    if not enabled:
        return '', '扫描页或图片需要OCR，尚未启用本机OCR'
    executable = shutil.which('tesseract')
    if not executable:
        return '', '本机OCR引擎未安装'
    with tempfile.TemporaryDirectory(prefix='recruitment-ocr-') as directory:
        filename = os.path.join(directory, 'page.png')
        image.thumbnail((2400, 3200))
        image.save(filename)
        result = subprocess.run([executable, filename, 'stdout', '-l', 'chi_sim+eng', '--psm', '3'],
                                capture_output=True, timeout=35, env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
        if result.returncode:
            return '', '本机OCR未完成，需检查中文语言包'
        return result.stdout.decode('utf-8').strip()[:MAX_TEXT], 'OCR文字仅供复核，未确认表格列关系及数字'


def pdf(data, enabled):
    try:
        import pdfplumber
    except ImportError:
        return {'tables': [], 'pages': [], 'issues': ['PDF表格引擎未安装'], 'method': 'needs-engine'}
    tables, pages, issues = [], [], []
    with pdfplumber.open(io.BytesIO(data)) as document:
        if len(document.pages) > 60:
            raise ValueError('PDF超过60页上限')
        for number, page in enumerate(document.pages, 1):
            text = page.extract_text() or ''
            if any(image.get('width', 0) * image.get('height', 0) > page.width * page.height * 0.1 for image in page.images) and len(text.strip()) >= 20:
                issues.append(f'PDF第{number}页含较大图片，图片内文字尚未核对')
            if sum(len(p['text']) for p in pages) + len(text) > MAX_TEXT:
                raise ValueError('PDF文字超过上限')
            if len(text.strip()) < 20:
                if enabled and number <= 6 and page.width * page.height < 2_000_000:
                    try:
                        text, issue = ocr_image(page.to_image(resolution=150).original, enabled)
                    except Exception:
                        text, issue = '', '扫描页OCR未完成'
                else:
                    issue = '扫描页需要OCR或已达到本轮6页OCR上限'
                issues.append(f'PDF第{number}页：{issue}')
                pages.append({'number': number, 'text': text, 'ocr': True})
                continue
            # Only drawn ruling lines establish native row/column boundaries.
            # Text alignment alone is not sufficient to promote a row.
            found = page.find_tables(table_settings={
                'vertical_strategy': 'lines', 'horizontal_strategy': 'lines',
                'snap_tolerance': 3, 'join_tolerance': 3, 'intersection_tolerance': 3,
            })
            for index, table in enumerate(found, 1):
                xs = sorted(set(round(edge, 2) for cell in table.cells for edge in (cell[0], cell[2])))
                ys = sorted(set(round(edge, 2) for cell in table.cells for edge in (cell[1], cell[3])))
                if len(ys) > 10001 or len(xs) > 201 or len(ys) * len(xs) > 500000:
                    raise ValueError('PDF表格超过行列上限')
                grid = [['' for _ in xs[:-1]] for _ in ys[:-1]]
                # Propagate only an actual drawn merged-cell rectangle. A plain
                # empty cell is never filled from an unrelated previous record.
                for bbox in table.cells:
                    left, top, right, bottom = (round(value, 2) for value in bbox)
                    value = page.crop(bbox).extract_text(x_tolerance=2, y_tolerance=3) or ''
                    for r in range(ys.index(top), ys.index(bottom)):
                        for c in range(xs.index(left), xs.index(right)):
                            if grid[r][c] and grid[r][c] != value:
                                raise ValueError('PDF单元格边界存在歧义')
                            grid[r][c] = value
                tables.append({'grid': grid, 'locator': f'PDF第{number}页表{index}', 'method': 'pdf-lines',
                               'bbox': list(table.bbox)})
            def outside_tables(obj):
                if obj.get('object_type') != 'char':
                    return False
                x, y = (obj['x0'] + obj['x1']) / 2, (obj['top'] + obj['bottom']) / 2
                return not any(t.bbox[0] <= x <= t.bbox[2] and t.bbox[1] <= y <= t.bbox[3] for t in found)
            notes = page.filter(outside_tables).extract_text() or ''
            pages.append({'number': number, 'text': text, 'notes': notes, 'ocr': False})
            page.close()
    return {'tables': tables, 'pages': pages, 'issues': issues, 'method': 'pdf-lines'}


def main():
    raw = sys.stdin.buffer.read(7_000_001)
    if len(raw) > 7_000_000:
        raise ValueError('输入超过上限')
    payload = json.loads(raw)
    data = base64.b64decode(payload['data'], validate=True)
    if not 0 < len(data) <= MAX_BYTES:
        raise ValueError('附件大小无效')
    fmt = payload['format']
    if fmt == 'docx' and data.startswith(b'PK'):
        result = docx(data)
    elif fmt == 'pdf' and data.startswith(b'%PDF-'):
        result = pdf(data, payload.get('ocr') is True)
    elif fmt in ('png', 'jpg', 'jpeg'):
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 16_000_000
        image = Image.open(io.BytesIO(data), formats=['PNG', 'JPEG'])
        if image.width * image.height > 16_000_000:
            raise ValueError('图片像素超过上限')
        text, issue = ocr_image(image, payload.get('ocr') is True)
        result = {'tables': [], 'pages': [{'number': 1, 'text': text, 'ocr': True}], 'issues': [issue], 'method': 'ocr-review'}
    elif fmt == 'doc' and data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        executable = shutil.which('antiword')
        if not executable:
            result = {'tables': [], 'pages': [], 'issues': ['旧版DOC需要antiword或手动转换为DOCX'], 'method': 'needs-engine'}
        else:
            with tempfile.TemporaryDirectory(prefix='recruitment-doc-') as directory:
                filename = os.path.join(directory, 'document.doc')
                with open(filename, 'wb') as stream:
                    stream.write(data)
                extracted = subprocess.run([executable, filename], capture_output=True, timeout=25, check=True)
                result = {'tables': [], 'pages': [{'number': 1, 'text': extracted.stdout.decode('utf-8', errors='replace')[:MAX_TEXT]}],
                          'issues': ['旧版DOC已提取文字，未确认表格列关系'], 'method': 'doc-text'}
    else:
        raise ValueError('附件格式或文件签名不符')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not expose file paths or document contents through errors.
        print(json.dumps({'error': '附件文档引擎未完成解析（格式损坏、超限或依赖不可用）'}, ensure_ascii=False))
        sys.exit(1)
