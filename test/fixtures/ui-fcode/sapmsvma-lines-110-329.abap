
include msvmao01.
INCLUDE MSVMAF01.                                           "MF 141200

*----------------------------------------------------------------------*
* Process After Input                                                  *
*----------------------------------------------------------------------*
module action.
  function = ok_code.
  dynnr = sy-dynnr.
  clear ok_code.
  clear action.
  clear range_limits_input.
*----------------------------------------------------------------------*
* gewählte Bearbeitung ermitteln                                       *
*----------------------------------------------------------------------*
  if vimdynflds-ltd_dta_ar ne space.
    case function.
      when 'UPD '. move 'UPDL' to function.
      when 'SHOW'. move 'SHOL' to function.
      when 'TRSP'. move 'TRSL' to function.
    endcase.
  endif.
  case function.
    when 'ENDE' or 'BACK'.  set screen 0. leave screen.
    when 'IMG'.                                             "ufsm31
      perform call_img using viewname.
      exit.
    when 'SHOW'.
      update = p. update_ltd = p.
      show   = x. show_ltd   = p.
      action = s. range_limits_input = space.
      transport = p. transp_ltd = p.
    when 'SHOL'.
      update = p. update_ltd = p.
      show   = p. show_ltd   = x.
      action = s. range_limits_input = x.
      transport = p. transp_ltd = p.
    when 'TRSP'.
      update = p. update_ltd = p.
      show   = p. show_ltd   = p.
      transport = x. transp_ltd = p.
      action = t. range_limits_input = space.
    when 'TRSL'.
      update = p. update_ltd = p.
      show   = p. show_ltd   = p.
      transport = p. transp_ltd = x.
      action = t. range_limits_input = x.
    when 'UPD '.
      update = x. update_ltd = p.
      show   = p. show_ltd   = p.
      transport = p. transp_ltd = p.
      action = u. range_limits_input = space.
    when 'UPDL'.
      update = p. update_ltd = x.
      show   = p. show_ltd   = p.
      action = u. range_limits_input = x.
      transport = p. transp_ltd = p.
    when 'VVCL'.                                            "ufsm31b
      if cluster_ta = space.
        TRY.
          CALL TRANSACTION 'SM34' WITH AUTHORITY-CHECK.
        CATCH cx_sy_authorization_error.
          MESSAGE E077(s#) WITH 'SM34'.
        ENDTRY.
      else.
        TRY.
          CALL TRANSACTION 'SM30' WITH AUTHORITY-CHECK.
        CATCH cx_sy_authorization_error.
          MESSAGE E077(s#) WITH 'SM30'.
        ENDTRY.
      endif.                                                "ufsm31e
      exit.
    WHEN 'ACTV'.
      TRY.
        CALL TRANSACTION 'S_CUS_IMG_ACTIVITY' WITH AUTHORITY-CHECK.
      CATCH cx_sy_authorization_error.
        MESSAGE E077(s#) WITH 'S_CUS_IMG_ACTIVITY'.
        RETURN.
      ENDTRY.
    when 'SHCO'.
      CLEAR ok_code.
      PERFORM show_customizing_objects.
      SET SCREEN dynnr.
      LEAVE SCREEN.
    when space.                        "Ankreuzfelder
      move: update     to dummy,
            update_ltd to dummy+1,
            show       to dummy+2,
            show_ltd   to dummy+3,
            transport  to dummy+4,
            transp_ltd to dummy+5.
      translate dummy using ' .'.
     if dummy ne x_update and dummy ne x_updltd and dummy ne x_show and
          dummy ne x_sholtd and dummy ne x_transp and dummy ne x_trpltd.
        countx = 0.
        do 6 times.
          assign dummy+sy-loopc(1) to <dum>.
          if <dum> eq x. add 1 to countx. endif.
        enddo.
        if countx = 0.
          if menu = 'X'.
            set cursor field 'UPDATE'.
            set pf-status 'ERROR'.
            message e020.
          endif.
          exit.
        elseif countx gt 1.
          set cursor field 'UPDATE'.
          set pf-status 'ERROR'.
          message e021.
        endif.
      endif.
      if update eq x or update_ltd eq x.
        add 1 to countx. action = u.
        move update_ltd to range_limits_input.
      endif.
      if show eq x or show_ltd eq x.
        add 1 to countx. action = s.
        move show_ltd to range_limits_input.
      endif.
      if transport eq x or transp_ltd eq x.
        add 1 to countx. action = t.
        move transp_ltd to range_limits_input.
      endif.
      translate range_limits_input using '. '.
  endcase.
*----------------------------------------------------------------------*
* Prüfen, ob gültige Eingabe erfolgte
*----------------------------------------------------------------------*
*  CASE ACTION.
*    WHEN U.
*    WHEN T.
*    WHEN S.
*    WHEN OTHERS.
*      SET PF-STATUS 'ERROR'.
*      MESSAGE E020.
*  ENDCASE.
*----------------------------------------------------------------------*
* ggf. Funktionen ausschließen                                         *
*----------------------------------------------------------------------*
  if cluster_ta = space.                                    "SW 261095
    refresh fu_to_excl.
    if menu ne space.
      move 'ATAB' to fu_to_excl-function. append fu_to_excl.
    endif.
  endif.                                                    "SW 261095
*----------------------------------------------------------------------*
* Funktionsbaustein für View-Pflege rufen                              *
*----------------------------------------------------------------------*
  if cluster_ta = 'X'.                                      "SW 261095
    set cursor field 'VCLDIR-VCLNAME'.                      "SW 261095
  else.                                                     "SW 261095
    set cursor field 'VIEWNAME'.
  endif.
  set pf-status 'ERROR'.
  if menu eq space.
    if cluster_ta = 'X'.                                    "SW 261095
      call function 'VIEWCLUSTER_MAINTENANCE_CALL'          "SW 261095
         exporting
              viewcluster_name   = viewname
*             START_OBJECT       = '          '
              maintenance_action = action
*             READ_KIND          = ' '
              show_selection_popup = range_limits_input
         exceptions
              foreign_lock       = 2.
    else.                                                   "SW 261095
      call function 'VIEW_MAINTENANCE_CALL'
           exporting
                action                 = action
                show_selection_popup   = range_limits_input
                view_name              = viewname
                variant_for_selection  = variant
                check_ddic_mainflag    = 'X'                "MF 081100
           tables
                dba_sellist            = rangetab
                excl_cua_funct         = fu_to_excl
           exceptions
                foreign_lock           = 2
                no_tvdir_entry         = 8.
      clear rc.
      case sy-subrc.
        when 0.
        when 2.
        when 8.
          if 'US' cs action.
            perform use_old_maintenance changing action
                                                 rc.
          endif.
        when others.
          rc = 4.
      endcase.
      case rc.
        when 4.
* Does table exist?
          call function 'DDIF_NAMETAB_GET'
               exporting
                    tabname   = viewname
               exceptions
                    not_found = 1
                    others    = 2.
          if sy-subrc <> 0.
            message e164 with viewname.
*   Tabelle/View &1 ist nicht im Dictionary vorhanden.
          else.
            message e037 with viewname.
          endif.                       "sy-subrc
        when 8.
          if sy-subrc <> 0.
            message e164 with viewname.
*   Tabelle/View &1 ist nicht im Dictionary vorhanden.
          else.
            message e037 with viewname.
          endif.                       "sy-subrc
      endcase.                                              "rc
    endif.  "cluster_ta                                    "SW 261095
  else.
* bei Aufruf aus dem Menü Leerbild prozessieren                        *
    set screen 101. leave screen.
