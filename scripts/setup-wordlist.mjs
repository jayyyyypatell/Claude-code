/**
 * Words for generated passphrases.
 *
 * Chosen to be typeable on an iPhone keyboard without autocorrect fighting
 * you: no homophones, no plurals of other entries, nothing that a phone
 * capitalises or "corrects".
 *
 * 283 words, so four of them is ~32 bits. That is not a lot in the abstract,
 * but the attacker has to already be on your WiFi to reach the login form at
 * all, and it is short enough that people will actually type it on a phone
 * rather than pick something worse. Five words gets you ~41 bits if you want
 * it; it is a generated default, not a policy.
 */
export const WORDS = `
anchor amber apple arbor arrow aspen atlas autumn bamboo banjo basil beacon
beetle birch bishop bison blossom bramble breeze bridge bronze brook buffalo
cabin cactus canyon carbon cargo carrot castle cedar cello chalk cherry chisel
cider cinder cliff clover cobalt comet compass copper coral cotton crane crater
crimson crystal cypress daisy dawn delta denim desert diamond domino donkey
dragon driftwood dune eagle ember emerald falcon fennel fern fiddle flint
forest fossil fountain fox garnet ginger glacier granite grotto hammer harbor
harvest hazel heron hickory hollow honey hornet indigo iris ivory jasmine
jetty juniper kettle kite lagoon lantern lark lattice lava lemon lichen lilac
linen lobster locust lotus lumber lupine magnet mango maple marble marlin
meadow mesa meteor mineral mint mirror moss motto nectar needle nickel nomad
oasis obsidian ochre olive onyx opal orbit orchid osprey otter owl oxide
paddle pampas papaya paprika parcel pastel pebble pelican pepper petal pewter
pigeon pilot pine pinion pistol pivot plank plaza plum pollen pond poplar
poppy porch portal prairie prism puffin pumice quartz quiver radish rafter
rapids raven reed reef relic rhubarb ribbon ridge ripple river robin rocket
rope rosemary rudder rust saffron sage salmon sandal sapphire satchel scarlet
sculpin seagull sequoia shale shelter shovel signal silo silver siren slate
sleigh slope smoke socket sorrel spark sparrow spindle spiral spruce stallion
starling stencil stone stork stream stucco sugar sulfur summit sunset swallow
sycamore syrup tabby talon tandem tangerine tapestry teal tempo terrace thicket
thimble thistle thorn thunder timber tinder topaz torch tortoise totem trellis
trout tulip tundra turbine turquoise umber urchin valley vanilla velvet vertex
vessel vine violet vulture walnut walrus warbler wattle weaver whistle willow
window winter wombat woodland wren yarrow yucca zenith zephyr zinc zircon
`.trim().split(/\s+/);
