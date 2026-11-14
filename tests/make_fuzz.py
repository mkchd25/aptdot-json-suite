"""Builds fuzz cases with Python's csv module as the reference parser."""
import csv, io, json, random, sys
random.seed(20261113)
ALPH = ['a', 'b', 'Z', '1', ' ', ',', ';', '\t', '|', '"', '\n', '\r\n', 'é', '中', '😀', "'", '=']
def field():
    r = random.random()
    if r < 0.1: return ''
    return ''.join(random.choice(ALPH) for _ in range(random.randint(1, 8)))
cases = []
for n in range(600):
    delim = random.choice([',', ',', ';', '\t', '|'])
    ncols = random.randint(1, 6)
    rows = [[field() for _ in range(ncols)] for _ in range(random.randint(1, 8))]
    # Python writes a lone empty field as '""'; avoid rows that are entirely empty single fields being ambiguous
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=delim, lineterminator=random.choice(['\r\n', '\n']), quoting=random.choice([csv.QUOTE_MINIMAL, csv.QUOTE_ALL]))
    w.writerows(rows)
    text = buf.getvalue()
    expected = list(csv.reader(io.StringIO(text, newline=''), delimiter=delim))
    expected = [r for r in expected if r != []]   # csv.reader yields [] for blank lines
    cases.append({'delimiter': delim, 'csv': text, 'rows': expected, 'ncols': ncols})
json.dump(cases, open(sys.argv[1], 'w'), ensure_ascii=False)
print(len(cases), 'cases')
