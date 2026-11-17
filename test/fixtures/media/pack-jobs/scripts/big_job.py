import os, sys, time
out = sys.argv[sys.argv.index("--out") + 1]
with open(os.path.join(out, "big.bin"), "wb") as f:
    while True:
        f.write(b"x" * 65536)
        f.flush()
        time.sleep(0.01)
