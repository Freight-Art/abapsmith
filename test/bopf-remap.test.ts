/**
 * `remapNodeIds` (src/adt/bopf-xml.ts) — BOPF re-mints every `bo:nodeID`
 * on each model PUT, so an undo that PUTs a stored before-image back
 * verbatim gets rejected by the server ("root node key is inconsistent!").
 * REAL_BEFORE/REAL_CURRENT below are two real ADT responses for the same
 * BOPF business object (issue #200) — one read before a model PUT, one read
 * right after it — used verbatim as fixtures, no host/credentials in either.
 */
import { describe, expect, it } from "vitest";
import { remapNodeIds, bopfModelComparable } from "../src/adt/bopf-xml.js";
import { sourceFingerprint } from "../src/journal.js";

/** Real GET response for ZAS_BO200, before the PUT that re-minted its node IDs. */
const REAL_BEFORE = `<?xml version="1.0" encoding="utf-8"?><bo:businessObject bo:objectCategory="businessProcessObject" bo:isExtensible="false" bo:programmingModel="Classic BOPF" bo:objectModelGenerated="false" bo:thirdGenBO="true" bo:smartValidation="false" bo:rapBO="false" adtcore:responsible="ABAPSMITH" adtcore:masterLanguage="EN" adtcore:masterSystem="A4H" adtcore:name="ZAS_BO200" adtcore:type="BOBF" adtcore:changedAt="2026-09-23T20:35:46Z" adtcore:version="active" adtcore:createdAt="2026-09-23T20:34:39Z" adtcore:changedBy="ABAPSMITH" adtcore:createdBy="ABAPSMITH" adtcore:description="issue 200 bo" adtcore:language="EN" xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core"><atom:link rel="http://www.sap.com/adt/categories/businessobjects/draftReference" title="Draft Reference" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/rootNode" title="Root Node" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/reactDuringSave" title="React During Save" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/exportParameterLinkedAction" title="Export Parameter Link in Action" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/abstractEntitiesAndRaiBOs" title="Abstract Entities and RAI BOs" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/bdefinRaiBOs" title="Behaviour Definition in RAI BOs" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/drawNumbersDuringCreate" title="Draw Numbers during create" xmlns:atom="http://www.w3.org/2005/Atom"/><adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/><bo:constantsInterfaceRef adtcore:uri="/sap/bc/adt/oo/interfaces/zif_as_bo200_c" adtcore:type="INTF/OI" adtcore:name="ZIF_AS_BO200_C"/><bo:nodes bo:name="ROOT" bo:nodeID="Rm9GyAZgH+Gt8ctOvgdAaQ==" bo:xmlName="ROOT" bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="true" bo:objectModelObsolete="false"><bo:persistentStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s200" adtcore:type="TABL/DS" adtcore:name="ZAS_S200"/><bo:combinedStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s_root" adtcore:type="TABL/DS" adtcore:name="ZAS_S_ROOT"/><bo:combinedTableRef adtcore:uri="/sap/bc/adt/ddic/tabletypes/zas_t_root" adtcore:type="TTYP/DA" adtcore:name="ZAS_T_ROOT"/><bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zas_d_root" adtcore:type="TABL/DT" adtcore:name="ZAS_D_ROOT"/><bo:properties bo:name="KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="PARENT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="ROOT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="ORDER_ID" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="AMOUNT" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:queries bo:name="SELECT_ALL" bo:nodeID="466F46C806601FE1ADF1CB4EBE0A6069" bo:objectModelGenerated="false" bo:xmlName="SELECT_ALL Query" bo:category="selectAll"/><bo:queries bo:name="SELECT_BY_ELEMENTS" bo:nodeID="466F46C806601FE1ADF1CB4EBE0A8069" bo:objectModelGenerated="false" bo:xmlName="SELECT_BY_ELEMENT Query" bo:category="selectByElements"><bo:dataTypeRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s_root" adtcore:type="TABL/DS" adtcore:name="ZAS_S_ROOT"/></bo:queries><bo:actions bo:name="LOCK_ROOT" bo:nodeID="466F46C806601FE1ADF1CB4EBE080069" bo:exportingParameterCategoryType="None" bo:objectModelGenerated="true" bo:category="3" bo:isExtensible="false" bo:exportParameterLink="false" bo:instanceMultiplicity="2"><bo:implementationClassRef adtcore:uri="/sap/bc/adt/oo/classes/%2fbobf%2fcl_lib_a_lock" adtcore:type="CLAS/OC" adtcore:name="/BOBF/CL_LIB_A_LOCK"/><bo:parameterStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/%2fbobf%2fs_frw_lock_parameters" adtcore:type="TABL/DS" adtcore:name="/BOBF/S_FRW_LOCK_PARAMETERS"/></bo:actions></bo:nodes></bo:businessObject>`;

/** Real GET response for the same BO, read back right after that PUT. */
const REAL_CURRENT = `<?xml version="1.0" encoding="utf-8"?><bo:businessObject bo:objectCategory="businessProcessObject" bo:isExtensible="false" bo:programmingModel="Classic BOPF" bo:objectModelGenerated="false" bo:thirdGenBO="true" bo:smartValidation="false" bo:rapBO="false" adtcore:responsible="ABAPSMITH" adtcore:masterLanguage="EN" adtcore:masterSystem="A4H" adtcore:name="ZAS_BO200" adtcore:type="BOBF" adtcore:changedAt="2026-09-23T20:36:21Z" adtcore:version="inactive" adtcore:createdAt="2026-09-23T20:34:39Z" adtcore:changedBy="ABAPSMITH" adtcore:createdBy="ABAPSMITH" adtcore:description="issue 200 bo" adtcore:language="EN" xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core"><atom:link rel="http://www.sap.com/adt/categories/businessobjects/draftReference" title="Draft Reference" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/rootNode" title="Root Node" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/reactDuringSave" title="React During Save" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/exportParameterLinkedAction" title="Export Parameter Link in Action" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/abstractEntitiesAndRaiBOs" title="Abstract Entities and RAI BOs" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/bdefinRaiBOs" title="Behaviour Definition in RAI BOs" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/drawNumbersDuringCreate" title="Draw Numbers during create" xmlns:atom="http://www.w3.org/2005/Atom"/><adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/><bo:constantsInterfaceRef adtcore:uri="/sap/bc/adt/oo/interfaces/zif_as_bo200_c" adtcore:type="INTF/OI" adtcore:name="ZIF_AS_BO200_C"/><bo:nodes bo:name="ROOT" bo:nodeID="Rm9GyAZgH+Gt8c3xxCGgaQ==" bo:xmlName="ROOT" bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" bo:updateEnabled="false" bo:deleteEnabled="true" bo:rootNode="true" bo:objectModelObsolete="false"><bo:persistentStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s200" adtcore:type="TABL/DS" adtcore:name="ZAS_S200"/><bo:combinedStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s_root" adtcore:type="TABL/DS" adtcore:name="ZAS_S_ROOT"/><bo:combinedTableRef adtcore:uri="/sap/bc/adt/ddic/tabletypes/zas_t_root" adtcore:type="TTYP/DA" adtcore:name="ZAS_T_ROOT"/><bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zas_d_root" adtcore:type="TABL/DT" adtcore:name="ZAS_D_ROOT"/><bo:properties bo:name="KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="PARENT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="ROOT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="ORDER_ID" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="AMOUNT" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:queries bo:name="SELECT_ALL" bo:nodeID="466F46C806601FE1ADF1CDF1C424C069" bo:objectModelGenerated="false" bo:xmlName="SELECT_ALL Query" bo:category="selectAll"/><bo:queries bo:name="SELECT_BY_ELEMENTS" bo:nodeID="466F46C806601FE1ADF1CDF1C424E069" bo:objectModelGenerated="false" bo:xmlName="SELECT_BY_ELEMENT Query" bo:category="selectByElements"><bo:dataTypeRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s_root" adtcore:type="TABL/DS" adtcore:name="ZAS_S_ROOT"/></bo:queries><bo:actions bo:name="LOCK_ROOT" bo:nodeID="466F46C806601FE1ADF1CDF1C4226069" bo:exportingParameterCategoryType="None" bo:objectModelGenerated="true" bo:category="3" bo:isExtensible="false" bo:exportParameterLink="false" bo:instanceMultiplicity="2"><bo:implementationClassRef adtcore:uri="/sap/bc/adt/oo/classes/%2fbobf%2fcl_lib_a_lock" adtcore:type="CLAS/OC" adtcore:name="/BOBF/CL_LIB_A_LOCK"/><bo:parameterStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/%2fbobf%2fs_frw_lock_parameters" adtcore:type="TABL/DS" adtcore:name="/BOBF/S_FRW_LOCK_PARAMETERS"/></bo:actions></bo:nodes></bo:businessObject>`;

describe("remapNodeIds", () => {
  it("remaps ROOT, SELECT_ALL, SELECT_BY_ELEMENTS, LOCK_ROOT to the current model's IDs, and nothing else", () => {
    const expected = REAL_BEFORE
      .replace('bo:nodeID="Rm9GyAZgH+Gt8ctOvgdAaQ=="', 'bo:nodeID="Rm9GyAZgH+Gt8c3xxCGgaQ=="')
      .replace('bo:nodeID="466F46C806601FE1ADF1CB4EBE0A6069"', 'bo:nodeID="466F46C806601FE1ADF1CDF1C424C069"')
      .replace('bo:nodeID="466F46C806601FE1ADF1CB4EBE0A8069"', 'bo:nodeID="466F46C806601FE1ADF1CDF1C424E069"')
      .replace('bo:nodeID="466F46C806601FE1ADF1CB4EBE080069"', 'bo:nodeID="466F46C806601FE1ADF1CDF1C4226069"');
    expect(expected).not.toBe(REAL_BEFORE); // sanity: the replace actually matched all four

    const out = remapNodeIds(REAL_BEFORE, REAL_CURRENT);
    expect(out).toBe(expected);
  });

  it('keeps bo:updateEnabled="true" from the before-image (only IDs are remapped, not other attributes)', () => {
    const out = remapNodeIds(REAL_BEFORE, REAL_CURRENT);
    expect(out).toContain('bo:updateEnabled="true"');
    expect(out).not.toContain('bo:updateEnabled="false"');
  });

  it("leaves an element's ID unchanged when it exists only in the before-image (e.g. undoing a remove)", () => {
    const before = REAL_BEFORE.replace(
      '<bo:actions bo:name="LOCK_ROOT"',
      '<bo:queries bo:name="SELECT_EXTRA" bo:nodeID="EXTRAONLYINBEFORE"/><bo:actions bo:name="LOCK_ROOT"',
    );
    expect(before).not.toBe(REAL_BEFORE); // sanity: the splice point matched

    const out = remapNodeIds(before, REAL_CURRENT);
    expect(out).toContain('bo:nodeID="EXTRAONLYINBEFORE"');
  });

  it("leaves both IDs unchanged when a key is duplicated in the before-image", () => {
    const before = REAL_BEFORE.replace(
      '<bo:actions bo:name="LOCK_ROOT"',
      '<bo:queries bo:name="SELECT_ALL" bo:nodeID="DUPSECONDID"/><bo:actions bo:name="LOCK_ROOT"',
    );
    expect(before).not.toBe(REAL_BEFORE); // sanity: the splice point matched

    const out = remapNodeIds(before, REAL_CURRENT);
    // "SELECT_ALL" is now ambiguous (two nodeIDs for the same key) -> both original IDs pass through untouched.
    expect(out).toContain('bo:nodeID="466F46C806601FE1ADF1CB4EBE0A6069"');
    expect(out).toContain('bo:nodeID="DUPSECONDID"');
    expect(out).not.toContain('bo:nodeID="466F46C806601FE1ADF1CDF1C424C069"');
  });

  it("remaps a child node's own ID and its bo:parentNodeID (synthetic two-node model)", () => {
    const before =
      '<?xml version="1.0" encoding="utf-8"?><bo:businessObject bo:objectCategory="businessProcessObject" adtcore:name="ZAS_BO200" adtcore:type="BOBF" xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core">' +
      '<bo:nodes bo:name="ROOT" bo:nodeID="ROOTOLDID" bo:createEnabled="true" bo:rootNode="true"/>' +
      "<bo:nodes bo:name=\"ITEM\" bo:nodeID=\"ITEMOLDID\" bo:parent=\"#//bo:businessObject/bo:nodes[@bo:name='ROOT']\" bo:parentNodeID=\"ROOTOLDID\" bo:createEnabled=\"true\"/>" +
      "</bo:businessObject>";
    const current =
      '<?xml version="1.0" encoding="utf-8"?><bo:businessObject bo:objectCategory="businessProcessObject" adtcore:name="ZAS_BO200" adtcore:type="BOBF" xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core">' +
      '<bo:nodes bo:name="ROOT" bo:nodeID="ROOTNEWID" bo:createEnabled="true" bo:rootNode="true"/>' +
      "<bo:nodes bo:name=\"ITEM\" bo:nodeID=\"ITEMNEWID\" bo:parent=\"#//bo:businessObject/bo:nodes[@bo:name='ROOT']\" bo:parentNodeID=\"ROOTNEWID\" bo:createEnabled=\"true\"/>" +
      "</bo:businessObject>";

    const out = remapNodeIds(before, current);
    expect(out).toContain('bo:nodeID="ROOTNEWID"');
    expect(out).toContain('bo:nodeID="ITEMNEWID"');
    expect(out).toContain('bo:parentNodeID="ROOTNEWID"');
    expect(out).not.toContain("ROOTOLDID");
    expect(out).not.toContain("ITEMOLDID");
  });
});


/**
 * `bopfModelComparable` (src/adt/bopf-xml.ts) — activation swaps every
 * `bo:nodeID` back to the previously-active version's IDs and changes
 * `adtcore:changedAt`/`adtcore:version`, so comparing raw fingerprints of
 * an after-image against the post-activation model falsely reports drift.
 * REAL_AFTER_INACTIVE is a real PUT read-back (issue #200, version
 * "inactive", freshly-minted IDs distinct from REAL_BEFORE/REAL_CURRENT).
 */

/** Real PUT read-back for ZAS_BO200 (the after-image), before activation. */
const REAL_AFTER_INACTIVE = `<?xml version="1.0" encoding="utf-8"?><bo:businessObject bo:objectCategory="businessProcessObject" bo:isExtensible="false" bo:programmingModel="Classic BOPF" bo:objectModelGenerated="false" bo:thirdGenBO="true" bo:smartValidation="false" bo:rapBO="false" adtcore:responsible="ABAPSMITH" adtcore:masterLanguage="EN" adtcore:masterSystem="A4H" adtcore:name="ZAS_BO200" adtcore:type="BOBF" adtcore:changedAt="2026-09-23T20:57:50Z" adtcore:version="inactive" adtcore:createdAt="2026-09-23T20:34:39Z" adtcore:changedBy="ABAPSMITH" adtcore:createdBy="ABAPSMITH" adtcore:description="issue 200 bo" adtcore:language="EN" xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core"><atom:link rel="http://www.sap.com/adt/categories/businessobjects/draftReference" title="Draft Reference" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/rootNode" title="Root Node" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/reactDuringSave" title="React During Save" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/exportParameterLinkedAction" title="Export Parameter Link in Action" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/abstractEntitiesAndRaiBOs" title="Abstract Entities and RAI BOs" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/bdefinRaiBOs" title="Behaviour Definition in RAI BOs" xmlns:atom="http://www.w3.org/2005/Atom"/><atom:link rel="http://www.sap.com/adt/categories/businessobjects/drawNumbersDuringCreate" title="Draw Numbers during create" xmlns:atom="http://www.w3.org/2005/Atom"/><adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/><bo:constantsInterfaceRef adtcore:uri="/sap/bc/adt/oo/interfaces/zif_as_bo200_c" adtcore:type="INTF/OI" adtcore:name="ZIF_AS_BO200_C"/><bo:nodes bo:name="ROOT" bo:nodeID="Rm9GyAZgH+Gt8i4Du4WgaQ==" bo:xmlName="ROOT" bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" bo:updateEnabled="true" bo:deleteEnabled="false" bo:rootNode="true" bo:objectModelObsolete="false"><bo:persistentStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s200" adtcore:type="TABL/DS" adtcore:name="ZAS_S200"/><bo:combinedStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s_root" adtcore:type="TABL/DS" adtcore:name="ZAS_S_ROOT"/><bo:combinedTableRef adtcore:uri="/sap/bc/adt/ddic/tabletypes/zas_t_root" adtcore:type="TTYP/DA" adtcore:name="ZAS_T_ROOT"/><bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zas_d_root" adtcore:type="TABL/DT" adtcore:name="ZAS_D_ROOT"/><bo:properties bo:name="KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="PARENT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="ROOT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="ORDER_ID" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:properties bo:name="AMOUNT" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/><bo:queries bo:name="SELECT_ALL" bo:nodeID="466F46C806601FE1ADF22E03BB88C069" bo:objectModelGenerated="false" bo:xmlName="SELECT_ALL Query" bo:category="selectAll"/><bo:queries bo:name="SELECT_BY_ELEMENTS" bo:nodeID="466F46C806601FE1ADF22E03BB88E069" bo:objectModelGenerated="false" bo:xmlName="SELECT_BY_ELEMENT Query" bo:category="selectByElements"><bo:dataTypeRef adtcore:uri="/sap/bc/adt/ddic/structures/zas_s_root" adtcore:type="TABL/DS" adtcore:name="ZAS_S_ROOT"/></bo:queries><bo:actions bo:name="LOCK_ROOT" bo:nodeID="466F46C806601FE1ADF22E03BB866069" bo:exportingParameterCategoryType="None" bo:objectModelGenerated="true" bo:category="3" bo:isExtensible="false" bo:exportParameterLink="false" bo:instanceMultiplicity="2"><bo:implementationClassRef adtcore:uri="/sap/bc/adt/oo/classes/%2fbobf%2fcl_lib_a_lock" adtcore:type="CLAS/OC" adtcore:name="/BOBF/CL_LIB_A_LOCK"/><bo:parameterStructureRef adtcore:uri="/sap/bc/adt/ddic/structures/%2fbobf%2fs_frw_lock_parameters" adtcore:type="TABL/DS" adtcore:name="/BOBF/S_FRW_LOCK_PARAMETERS"/></bo:actions></bo:nodes></bo:businessObject>`;

describe("bopfModelComparable", () => {
  // Simulates activation: REAL_AFTER_INACTIVE with changedAt bumped, version
  // flipped to "active", and every bo:nodeID swapped back to the IDs
  // REAL_BEFORE (the previously-active version) used — the live behaviour
  // fix-bopf-drift.md describes.
  const activatedCurrent = REAL_AFTER_INACTIVE.replace(
    'adtcore:changedAt="2026-09-23T20:57:50Z"',
    'adtcore:changedAt="2026-09-23T21:05:00Z"',
  )
    .replace('adtcore:version="inactive"', 'adtcore:version="active"')
    .replace('bo:nodeID="Rm9GyAZgH+Gt8i4Du4WgaQ=="', 'bo:nodeID="Rm9GyAZgH+Gt8ctOvgdAaQ=="')
    .replace('bo:nodeID="466F46C806601FE1ADF22E03BB88C069"', 'bo:nodeID="466F46C806601FE1ADF1CB4EBE0A6069"')
    .replace('bo:nodeID="466F46C806601FE1ADF22E03BB88E069"', 'bo:nodeID="466F46C806601FE1ADF1CB4EBE0A8069"')
    .replace('bo:nodeID="466F46C806601FE1ADF22E03BB866069"', 'bo:nodeID="466F46C806601FE1ADF1CB4EBE080069"');

  it("has actually changed from the after-image (sanity: every replace above matched)", () => {
    expect(activatedCurrent).not.toBe(REAL_AFTER_INACTIVE);
    expect(activatedCurrent).not.toContain("466F46C806601FE1ADF22E03BB88C069");
    expect(activatedCurrent).toContain('adtcore:version="active"');
  });

  it("treats the after-image and the post-activation model as equal, ignoring node IDs and timestamps", () => {
    expect(sourceFingerprint(bopfModelComparable(activatedCurrent))).toBe(
      sourceFingerprint(bopfModelComparable(REAL_AFTER_INACTIVE)),
    );
  });

  it("still detects a real change (bo:deleteEnabled flipped) despite ignoring IDs and timestamps", () => {
    const changed = activatedCurrent.replace('bo:deleteEnabled="false"', 'bo:deleteEnabled="true"');
    expect(changed).not.toBe(activatedCurrent); // sanity: the splice point matched
    expect(sourceFingerprint(bopfModelComparable(changed))).not.toBe(
      sourceFingerprint(bopfModelComparable(REAL_AFTER_INACTIVE)),
    );
  });
});

// No planSpecialUndo-level test: the existing bopf-model undo coverage
// (test/bopf-journal.test.ts) drives it through a full FakeAdtServer +
// AbapConnection + SafetyGate + MCP client/server harness (see `wired()`
// there) rather than a lightweight mock of `readModel`/`Journal`; standing
// up an equivalent mock here without editing that file was judged too
// involved for this fix, per fix-bopf-drift.md's explicit allowance to skip.

