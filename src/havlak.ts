// Copyright 2012 Google Inc.
// All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import CFG = require('./cfg');
import BasicBlock = CFG.BasicBlock;

function mix(existing: number, value: number): number {
    return ((existing & 0x0fffffff) << 1) + value;
}

/** Basic representation of loops, a loop has an entry point,
    one or more exit edges, a set of basic blocks, and potentially
    an outer loop - a "parent" loop.

    Furthermore, it can have any set of properties, e.g.,
    it can be an irreducible loop, have control flow, be
    a candidate for transformations, and what not.
*/
export class SimpleLoop {
    basicBlocks: Array<BasicBlock> = [];
    children: Array<SimpleLoop> = [];
    counter: number;

    parent: SimpleLoop;
    header: BasicBlock;

    isRoot: boolean = false;
    isReducible: boolean = true;
    nestingLevel: number = 0;
    depthLevel: number = 0;

    constructor(counter: number) {
        this.counter = counter;
    }

    addNode(bb: BasicBlock): void {
        this.basicBlocks.push(bb);
    }

    addChildLoop(loop: SimpleLoop): void {
        this.children.push(loop);
    }

    setParent(p: SimpleLoop): void {
        this.parent = p;
        p.addChildLoop(this);
    }

    setHeader(bb: BasicBlock): void {
        this.basicBlocks.push(bb);
        this.header = bb;
    }

    setNestingLevel(level: number): void {
        this.nestingLevel = level;
        if (level === 0) {
            this.isRoot = true;
        }
    }

    checksum(): number {
        let result: number = this.counter;
        result = mix(result, this.isRoot ? 1 : 0);
        result = mix(result, this.isReducible ? 1 : 0);
        result = mix(result, this.nestingLevel);
        result = mix(result, this.depthLevel);
        if (this.header != null) {
            result = mix(result, this.header.name);
        }
        this.basicBlocks.forEach((e) => result = mix(result, e.name));
        this.children.forEach((e) => result = mix(result, e.checksum()));
        return result;
    }
}

//
// LoopStructureGraph
//
// Maintain loop structure for a given CFG.
//
// Two values are maintained for this loop graph, depth, and nesting level.
// For example:
//
// loop        nesting level    depth
//----------------------------------------
// loop-0      2                0
//   loop-1    1                1
//   loop-3    1                1
//     loop-2  0                2
//
export class LSG {
    loopCounter: number = 1;
    loops: Array<SimpleLoop> = [];
    root: SimpleLoop = new SimpleLoop(0);

    constructor() {
        this.root.setNestingLevel(0);
        this.loops.push(this.root);
    }

    createNewLoop(): SimpleLoop {
        return new SimpleLoop(this.loopCounter++);
    }

    addLoop(loop: SimpleLoop): void {
        this.loops.push(loop);
    }

    checksum(): number {
        let result: number = this.loops.length;
        this.loops.forEach((e) => result = mix(result, e.checksum()));
        return mix(result, this.root.checksum());
    }

    getNumLoops(): number {
        return this.loops.length;
    }
}

//======================================================
// Main Algorithm
//======================================================

//
// class UnionFindNode
//
// The algorithm uses the Union/Find algorithm to collapse
// complete loops into a single node. These nodes and the
// corresponding functionality are implemented with this class
//
class UnionFindNode {
    dfsNumber: number = 0;
    parent: UnionFindNode;
    bb: BasicBlock;
    loop: SimpleLoop;

    /// Initialize this node.
    initNode(bb: BasicBlock, dfsNumber: number): void {
        this.parent = this;
        this.bb = bb;
        this.dfsNumber = dfsNumber;
    }

    // Union/Find Algorithm - The find routine.
    //
    // Implemented with Path Compression (inner loops are only
    // visited and collapsed once, however, deep nests would still
    // result in significant traversals).
    //
    findSet(): UnionFindNode {
        let nodeList: Array<UnionFindNode> = [];

        let node: UnionFindNode = this;
        while (node !== node.parent) {
            if (node.parent !== node.parent.parent) {
                nodeList.push(node);
            }

            node = node.parent;
        }

        // Path Compression, all nodes' parents point to the 1st level parent.
        for (let iter: number = 0; iter < nodeList.length; ++iter) {
            nodeList[iter].parent = node.parent;
        }

        return node;
    }

    // Union/Find Algorithm - The union routine.
    //
    // Trivial. Assigning parent pointer is enough,
    // we rely on path compression.
    //
    union(unionFindNode: UnionFindNode): void {
        this.parent = unionFindNode;
    }

    setLoop(l: SimpleLoop): SimpleLoop {
        this.loop = l;
        return l;
    }
}

export class HavlakLoopFinder {
    cfg: CFG.CFG;
    lsg: LSG;

    static BB_TOP: number = 0; // uninitialized
    static BB_NONHEADER: number = 1; // a regular BB
    static BB_REDUCIBLE: number = 2; // reducible loop
    static BB_SELF: number = 3; // single BB loop
    static BB_IRREDUCIBLE: number = 4; // irreducible loop
    static BB_DEAD: number = 5; // a dead BB
    static BB_LAST: number = 6; // Sentinel

    // Marker for uninitialized nodes.
    static UNVISITED: number = -1;

    // Safeguard against pathologic algorithm behavior.
    static MAXNONBACKPREDS: number = (32 * 1024);

    constructor(cfg: CFG.CFG, lsg: LSG) {
        this.cfg = cfg;
        this.lsg = lsg;
    }

    //
    // IsAncestor
    //
    // As described in the paper, determine whether a node 'w' is a
    // "true" ancestor for node 'v'.
    //
    // Dominance can be tested quickly using a pre-order trick
    // for depth-first spanning trees. This is why DFS is the first
    // thing we run below.
    //
    private isAncestor(w: number, v: number, last: Array<number>): boolean {
        return (w <= v) && (v <= last[w]);
    }

    //
    // DFS - Depth-First-Search
    //
    // DESCRIPTION:
    // Simple depth first traversal along out edges with node numbering.
    //
    private DFS(currentNode: BasicBlock,
        nodes: Array<UnionFindNode>,
        numbers: Array<number>,
        last: Array<number>, current: number): number {
        nodes[current].initNode(currentNode, current);
        numbers[currentNode.name] = current;

        let lastid: number = current;
        for (let target: number = 0; target < currentNode.outEdges.length; target++) {
            if (numbers[currentNode.outEdges[target].name] === HavlakLoopFinder.UNVISITED) {
                lastid = this.DFS(currentNode.outEdges[target], nodes, numbers,
                    last, lastid + 1);
            }
        }

        last[numbers[currentNode.name]] = lastid;
        return lastid;
    }

    //
    // findLoops
    //
    // Find loops and build loop forest using Havlak's algorithm, which
    // is derived from Tarjan. Variable names and step numbering has
    // been chosen to be identical to the nomenclature in Havlak's
    // paper (which, in turn, is similar to the one used by Tarjan).
    //
    findLoops(): number {
        if (this.cfg.startNode == null) {
            return 0;
        }

        let size: number = this.cfg.getNumNodes();

        let nonBackPreds: Array<Array<number>> = new Array(size);
        let backPreds: Array<Array<number>> = new Array(size);
        let numbers: Array<number> = new Array(size);
        let header: Array<number> = new Array(size);
        let types: Array<number> = new Array(size);
        let last: Array<number> = new Array(size);
        let nodes: Array<UnionFindNode> = new Array(size);

        for (let i: number = 0; i < size; ++i) {
            nonBackPreds[i] = [];
            backPreds[i] = [];
            numbers[i] = HavlakLoopFinder.UNVISITED;
            header[i] = 0;
            types[i] = HavlakLoopFinder.BB_NONHEADER;
            last[i] = 0;
            nodes[i] = new UnionFindNode();
        }

        // Step a:
        //   - initialize all nodes as unvisited.
        //   - depth-first traversal and numbering.
        //   - unreached BB's are marked as dead.
        //
        this.DFS(this.cfg.startNode, nodes, numbers, last, 0);

        // Step b:
        //   - iterate over all nodes.
        //
        //   A backedge comes from a descendant in the DFS tree, and non-backedges
        //   from non-descendants (following Tarjan).
        //
        //   - check incoming edges 'v' and add them to either
        //     - the list of backedges (backPreds) or
        //     - the list of non-backedges (nonBackPreds)
        //
        for (let w: number = 0; w < size; ++w) {
            let nodeW: BasicBlock = nodes[w].bb;
            if (nodeW == null) {
                types[w] = HavlakLoopFinder.BB_DEAD;
            } else {
                if (nodeW.getNumPred() > 0) {
                    for (let nv: number = 0; nv < nodeW.inEdges.length; ++nv) {
                        let nodeV: BasicBlock = nodeW.inEdges[nv];
                        let v: number = numbers[nodeV.name];
                        if (v !== HavlakLoopFinder.UNVISITED) {
                            if (this.isAncestor(w, v, last)) {
                                backPreds[w].push(v);
                            } else {
                                nonBackPreds[w].push(v);
                            }
                        }
                    }
                }
            }
        }

        // Step c:
        //
        // The outer loop, unchanged from Tarjan. It does nothing except
        // for those nodes which are the destinations of backedges.
        // For a header node w, we chase backward from the sources of the
        // backedges adding nodes to the set P, representing the body of
        // the loop headed by w.
        //
        // By running through the nodes in reverse of the DFST preorder,
        // we ensure that inner loop headers will be processed before the
        // headers for surrounding loops.
        //
        for (let w: number = size - 1; w >= 0; --w) {
            // this is 'P' in Havlak's paper
            let nodePool: Array<UnionFindNode> = [];

            let nodeW: BasicBlock = nodes[w].bb;
            if (nodeW == null) {
                continue;
            }

            // Step d:
            for (let vi: number = 0; vi < backPreds[w].length; ++vi) {
                let v = backPreds[w][vi];
                if (v !== w) {
                    nodePool.push(nodes[v].findSet());
                } else {
                    types[w] = HavlakLoopFinder.BB_SELF;
                }
            }

            // Copy nodePool to workList.
            //
            let workList: Array<UnionFindNode> = [];
            for (let n: number = 0; n < nodePool.length; ++n) {
                workList.push(nodePool[n]);
            }

            if (nodePool.length !== 0) {
                types[w] = HavlakLoopFinder.BB_REDUCIBLE;
            }
            // work the list...
            //
            while (workList.length > 0) {
                let x: UnionFindNode = workList.shift();

                // Step e:
                //
                // Step e represents the main difference from Tarjan's method.
                // Chasing upwards from the sources of a node w's backedges. If
                // there is a node y' that is not a descendant of w, w is marked
                // the header of an irreducible loop, there is another entry
                // into this loop that avoids w.
                //

                // The algorithm has degenerated. Break and
                // return in this case.
                //
                let nonBackSize: number = nonBackPreds[x.dfsNumber].length;
                if (nonBackSize > HavlakLoopFinder.MAXNONBACKPREDS) {
                    return 0;
                }

                for (let iter: number = 0; iter < nonBackPreds[x.dfsNumber].length; ++iter) {
                    let y: UnionFindNode = nodes[nonBackPreds[x.dfsNumber][iter]];
                    let ydash: UnionFindNode = y.findSet();

                    if (!this.isAncestor(w, ydash.dfsNumber, last)) {
                        types[w] = HavlakLoopFinder.BB_IRREDUCIBLE;
                        nonBackPreds[w].push(ydash.dfsNumber);
                    } else {
                        if (ydash.dfsNumber !== w) {
                            if (nodePool.indexOf(ydash) === -1) {
                                workList.push(ydash);
                                nodePool.push(ydash);
                            }
                        }
                    }
                }
            }

            // Collapse/Unionize nodes in a SCC to a single node
            // For every SCC found, create a loop descriptor and link it in.
            //
            if ((nodePool.length > 0) || (types[w] === HavlakLoopFinder.BB_SELF)) {
                let loop: SimpleLoop = this.lsg.createNewLoop();

                loop.setHeader(nodeW);
                if (types[w] === HavlakLoopFinder.BB_IRREDUCIBLE) {
                    loop.isReducible = true;
                } else {
                    loop.isReducible = false;
                }

                // At this point, one can set attributes to the loop, such as:
                //
                // the bottom node:
                //    iter  = backPreds(w).begin();
                //    loop bottom is: nodes(iter).node;
                //
                // the number of backedges:
                //    backPreds(w).size()
                //
                // whether this loop is reducible:
                //    types(w) != BB_IRREDUCIBLE
                //
                nodes[w].loop = loop;

                for (let np: number = 0; np < nodePool.length; ++np) {
                    let node: UnionFindNode = nodePool[np];

                    // Add nodes to loop descriptor.
                    header[node.dfsNumber] = w;
                    node.union(nodes[w]);

                    // Nested loops are not added, but linked together.
                    if (node.loop != null) {
                        node.loop.setParent(loop);
                    } else {
                        loop.addNode(node.bb);
                    }
                }
                this.lsg.addLoop(loop);
            } // nodePool.length
        } // Step c

        return this.lsg.getNumLoops();
    } // findLoops
}
