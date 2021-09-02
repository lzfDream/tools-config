#! /usr/bin/python3
import os
import sys

def main(argv):
    cmd = ""
    for arg in argv[1:]:
        cmd = cmd + " " + arg

    cmd = cmd + " 2>&1"
    count = 0

    while True:
        val = os.popen(cmd).read() # 执行结果包含在val中
        pos = val.find('fatal')
        if pos == -1:
            print("success, ret:\n", val)
            break

        count = count + 1
        print("fatal count: ", count, "\n", val)


if __name__ == '__main__':
    main(sys.argv)
