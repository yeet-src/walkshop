# BPF objects for walkshop.
#
#   make bpf       link every bpf/<name>/ directory into bin/<name>.bpf.o
#   make clean-bpf
#   make veristat  load the objects and let this kernel's verifier judge them
#
# clang and bpftool come from the pinned static toolchain resolved by
# build/toolchain.mk — fetched once into a shared per-machine cache.

.DEFAULT_GOAL := bpf

include build/toolchain.mk
include build/bpf.mk
