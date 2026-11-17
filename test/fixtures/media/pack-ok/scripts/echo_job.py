import sys
from helper import shout

print(shout(sys.argv[1] if len(sys.argv) > 1 else ""))
